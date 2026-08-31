import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConfigError, runDerive } from '@haelan/core'
import type { OverrideScope } from '@haelan/core'
import { errorBody, statusFor } from '../../api/envelope.ts'
import { requireString } from './shared.ts'

interface PersonParams { personId: string }
interface OverrideParams extends PersonParams { overrideId: string }

interface OverrideBody {
  scope?: unknown
  targetKey?: unknown
  action?: unknown
  correctedValue?: unknown
  reason?: unknown
}

interface AffectedRange { from: string, to: string }

interface WriteResult {
  /**
   * Null when the write named a day nothing has yet: an override can be written for a sample or
   * a session a backfill has not reached, and the store marks nothing in that case. See
   * applyOverride for why that answers `applied: true`.
   */
  affected: AffectedRange | null
  applied: boolean
}

const SCOPES: readonly OverrideScope[] = ['sample', 'session', 'day_metric']
const ACTIONS = ['exclude', 'correct'] as const

/**
 * The same bound SyncRunner#derive carries, for the same reason: a drain that cannot finish has
 * to stop rather than hold the request open for as long as the backlog is long. Two hundred
 * batches of 64 is over twelve thousand days, which is more than any one correction should be
 * asked to pay for.
 */
const MAX_DRAIN_BATCHES = 200

/**
 * The two override mutations, and the derivation that makes them visible.
 *
 * runDerive has exactly one other caller, the sync runner, so an override written without
 * draining here would sit in the queue until the next sync and the reader would close the panel
 * looking at the number they just corrected.
 */
export function registerAnnotationRoutes(app: FastifyInstance): void {
  app.post<{ Params: PersonParams, Body: OverrideBody }>('/p/:personId/overrides', async (request, reply) => {
    const personId = personIdOf(request)
    const body = request.body ?? {}
    const scope = enumField(body.scope, SCOPES, 'scope')
    const targetKey = textField(body.targetKey, 'targetKey')
    const action = enumField(body.action, ACTIONS, 'action')
    const reason = textField(body.reason, 'reason')
    const correctedValue = numberField(body.correctedValue, 'correctedValue')

    const overrides = app.haelan.instance.overrides
    // No try/catch and no second transaction: put wraps the row and the queue mark in one
    // already, and registerV1's error handler turns its ConfigError into the shared 400.
    const id = overrides.put({ personId, scope, targetKey, action, correctedValue, reason, nowMs: app.haelan.now() })
    return reply.send({ id, ...applyOverride(app, personId, overrides.affectedLocalDate({ personId, scope, targetKey })) })
  })

  app.delete<{ Params: OverrideParams }>('/p/:personId/overrides/:overrideId', async (request, reply) => {
    const personId = personIdOf(request)
    const overrideId = request.params.overrideId
    const overrides = app.haelan.instance.overrides

    // Read through listFor, which is scoped to this person, so somebody else's override id is a
    // 404 here rather than a 200 over a store call that quietly did nothing. The store refuses it
    // too; both refusals stay, because the one the caller sees and the one that protects the row
    // are not the same guarantee.
    const stored = overrides.listFor(personId).find((row) => row.id === overrideId)
    if (!stored) {
      return reply.code(statusFor('not_found'))
        .send(errorBody('not_found', 'no_such_override', `no override '${overrideId}'`))
    }

    // Resolved before the removal, because the stored row is the only place the target was
    // recorded and the day to re-derive is a function of it.
    const localDate = overrides.affectedLocalDate({
      personId, scope: stored.scope, targetKey: stored.targetKey,
    })
    overrides.remove({ personId, id: overrideId, nowMs: app.haelan.now() })
    return reply.send({ id: overrideId, ...applyOverride(app, personId, localDate) })
  })
}

/**
 * registerV1's plugin wide guard has already refused this request unless :personId is the signed
 * in account's own person, so the path segment is the caller's person by the time a handler runs.
 * Read here rather than off personQuery, which keeps its person id private.
 */
function personIdOf(request: FastifyRequest<{ Params: PersonParams }>): string {
  return request.params.personId
}

/**
 * Derives the writer's own dirty days and answers whether the day just written came out of the
 * queue.
 *
 * `applied` is the queue's answer rather than the absence of a throw. DeriveQueue.claim takes the
 * oldest days first and this write marked its day now, so it sorts behind whatever a backfill or
 * a version bump rebuild left queued; a single runDerive call drains 64 days and can finish
 * cleanly without ever reaching it. Reporting that as applied would be exactly the failure this
 * field exists to prevent, so the loop bounds the work and the queue decides the answer.
 *
 * A null day means the store marked nothing, which is not a failure: the override names a sample
 * or a session that has not been synced yet, and the sync that writes those rows marks the day
 * itself. There is nothing queued to apply, so nothing is claimed to be pending either.
 */
function applyOverride(app: FastifyInstance, personId: string, localDate: string | null): WriteResult {
  if (localDate === null) return { affected: null, applied: true }
  drain(app, personId)
  return { affected: { from: localDate, to: localDate }, applied: !stillQueued(app, personId, localDate) }
}

/**
 * Failures stay inside, the way SyncRunner#derive keeps its own: the override is committed
 * whatever happens here, and a 500 over a saved correction invites the reader to write it a
 * second time. What the caller gets instead is `applied: false`, which is true.
 */
function drain(app: FastifyInstance, personId: string): void {
  const instance = app.haelan.instance
  try {
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch++) {
      const report = runDerive({
        db: instance.db,
        queue: instance.deriveQueue,
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: app.haelan.now(),
        // Scoped to the writer's own person. An unscoped drain would derive other people's dirty
        // days inside this request: work this caller did not ask for and, on a shared instance,
        // work about somebody else's data.
        personIds: [personId],
      })
      if (report.daysDerived === 0) return
    }
    console.log(`overrides: derivation for ${personId} stopped after ${MAX_DRAIN_BATCHES} batches with days still queued`)
  } catch (error) {
    console.error(`overrides: derivation for ${personId} failed, ${messageOf(error)}`)
  }
}

/** A queue that cannot be read answers "still queued", so an unknown state is never called applied. */
function stillQueued(app: FastifyInstance, personId: string, localDate: string): boolean {
  try {
    return app.haelan.instance.deriveQueue.has({ personId, localDate })
  } catch (error) {
    console.error(`overrides: could not read the derive queue for ${personId}, ${messageOf(error)}`)
    return true
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A JSON body carries types a query string cannot, so a field can arrive as a number or an
 * object where a string was meant. Narrowed here and then handed to shared.ts's requireString, so
 * a missing field and an empty one refuse in the same words as everywhere else on this surface.
 */
function textField(value: unknown, name: string): string {
  if (value !== undefined && typeof value !== 'string') throw new ConfigError(`${name} must be a string`)
  return requireString(value, name)
}

function enumField<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  const text = textField(value, name)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')}, got '${text}'`)
  }
  return text as T
}

/**
 * Absent and null both mean "no corrected value", which is what an excluding override carries.
 * The store decides whether that is allowed for the action given; this only refuses a value that
 * is not a number at all, since NaN would reach the daily rollup and land in a stored figure.
 */
function numberField(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${name} must be a finite number`)
  }
  return value
}
