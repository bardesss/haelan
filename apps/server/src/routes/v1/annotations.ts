import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  ConfigError, peopleNeedingRebuild, requireDate, runDerive,
} from '@haelan/core'
import type { OverrideScope, StoredOverride } from '@haelan/core'
import { parseSampleTarget } from '@haelan/core/target-key'
import { errorBody, statusFor } from '../../api/envelope.ts'
import { requireString, roundMetricValue, sendHashed } from './shared.ts'

interface PersonParams { personId: string }
interface OverrideParams extends PersonParams { overrideId: string }
interface NoteParams extends PersonParams { localDate: string }
interface EventParams extends PersonParams { eventId: string }
interface DateRangeQuery { from?: string, to?: string }

interface OverrideBody {
  scope?: unknown
  targetKey?: unknown
  action?: unknown
  correctedValue?: unknown
  reason?: unknown
}

interface NoteBody {
  body?: unknown
}

interface EventBody {
  kind?: unknown
  startedAtMs?: unknown
  startedAtOffsetMinutes?: unknown
  endedAtMs?: unknown
  endedAtOffsetMinutes?: unknown
  value?: unknown
  note?: unknown
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
 * Deliberately not SyncRunner's MAX_DERIVE_BATCHES, and deliberately not shared with it. A
 * background job that drains for a minute costs a long job; the same drain in a request handler
 * costs the whole process, because better-sqlite3 is synchronous and the loop never yields, so
 * every other route, every other person and the runner's own timers wait behind it.
 *
 * This precedent is already in the codebase: shared.ts carries MAX_RANGE_DAYS because one
 * authenticated GET once held the event loop for roughly twelve seconds, and that was treated as
 * a defect worth a guard of its own rather than as a slow request.
 *
 * 128 batches of the size below is a little over a thousand days, which is deep enough to carry a
 * correction out from behind an ordinary backfill backlog. The budget below, not this, is what
 * actually stops a drain; this only bounds the loop when every batch is cheap.
 */
const MAX_DRAIN_BATCHES = 128

/**
 * Eight days per batch rather than runDerive's default of 64.
 *
 * The budget below is checked between batches, so a batch is the granularity at which the drain
 * can be preempted and its size is how far past the budget a handler can run. At the default a
 * single batch of dense days could block for seconds with the budget unable to interrupt it,
 * which is a bound that reads as a guarantee and is not one. Eight keeps the worst overshoot to a
 * week of days while leaving the per batch overhead, one claim query and one settings read,
 * negligible against the derivation itself.
 */
export const DRAIN_BATCH_DAYS = 8

/**
 * The bound that actually protects the event loop, since how long a batch takes is a property of
 * the data rather than of the count.
 *
 * performance.now() rather than Date.now(), which is not monotonic: a system clock step, an NTP
 * correction or a daylight saving jump would otherwise move the budget under a drain in progress.
 * And rather than app.haelan.now(), the domain clock a test freezes, because what is being
 * limited here is real time spent not answering anybody else.
 */
const DRAIN_BUDGET_MS = 1_000

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
    // Resolved before the write, not after it. For a sample or a session this reads the database,
    // and a throw after put has committed would be a 500 over a saved override, which is the
    // outcome the 200 with applied false exists to avoid. A malformed key throws here instead,
    // where nothing has been written and the shared 400 is the right answer.
    const localDate = overrides.affectedLocalDate({ personId, scope, targetKey })
    // No try/catch and no second transaction: put wraps the row and the queue mark in one
    // already, and registerV1's error handler turns its ConfigError into the shared 400.
    const id = overrides.put({ personId, scope, targetKey, action, correctedValue, reason, nowMs: app.haelan.now() })
    return reply.send({ id, ...applyOverride(app, personId, localDate) })
  })

  app.delete<{ Params: OverrideParams }>('/p/:personId/overrides/:overrideId', async (request, reply) => {
    const personId = personIdOf(request)
    const overrideId = request.params.overrideId
    const overrides = app.haelan.instance.overrides

    // get is scoped by person as well as id, the way remove's own WHERE is, so somebody else's
    // override id is a 404 here rather than a 200 over a store call that quietly did nothing. The
    // store refuses it too; both refusals stay, because the one the caller sees and the one that
    // protects the row are not the same guarantee.
    const stored = overrides.get(personId, overrideId)
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

  // The four routes below take no drain, no loop, no budget and no `applied` field, which is not
  // an omission next to the two above it. An override changes what a derivation computes, so
  // writing one leaves a day for runDerive to recompute and the response has to say whether that
  // recomputation actually ran. A note or an event changes no derived number at all: it is
  // commentary a reader sees beside the numbers, not an input to any of them. NoteStore and
  // EventStore carry the same asymmetry one level down, both with a comment saying why, and this
  // one is its mirror at the HTTP boundary: nothing here marks a day dirty, so there is nothing to
  // apply and nothing to report applying.
  app.put<{ Params: NoteParams, Body: NoteBody }>('/p/:personId/notes/:localDate', async (request, reply) => {
    const personId = personIdOf(request)
    const localDate = request.params.localDate
    requireDate('localDate', localDate)
    const body = request.body ?? {}
    const noteBody = textField(body.body, 'body')

    const id = app.haelan.instance.notes.put({
      personId, localDate, body: noteBody, nowMs: app.haelan.now(),
    })
    return reply.send({ id })
  })

  app.delete<{ Params: NoteParams }>('/p/:personId/notes/:localDate', async (request, reply) => {
    const personId = personIdOf(request)
    const localDate = request.params.localDate
    requireDate('localDate', localDate)
    // No existence check first, matching events' DELETE below rather than overrides' own: a note
    // is keyed by (personId, localDate), unique on that pair (put's own comment in notes.ts names
    // the constraint), so there is no separate id in the path for a check to be scoped by the way
    // overrides' own is.
    // remove is already scoped by personId as well as localDate, so a day this person never wrote
    // does nothing rather than something. The response echoes localDate back under `id`, the same
    // shape events' own delete answers with, since this route never fetched the row and so never
    // learned the note's own id.
    app.haelan.instance.notes.remove({ personId, localDate })
    return reply.send({ id: localDate })
  })

  app.post<{ Params: PersonParams, Body: EventBody }>('/p/:personId/events', async (request, reply) => {
    const personId = personIdOf(request)
    const body = request.body ?? {}
    // kind is deliberately not validated against a fixed list: the schema's own column comment
    // names a seed set but declined to enforce it, so refusing an unlisted kind here would add
    // back a rule the schema chose not to make.
    const kind = textField(body.kind, 'kind')
    const startedAtMs = requiredNumberField(body.startedAtMs, 'startedAtMs')
    // Offset defaults to 0 (UTC) rather than being required: a caller that only has an instant,
    // with no local timezone to attach to it, still has an event worth recording.
    const startedAtOffsetMinutes = numberField(body.startedAtOffsetMinutes, 'startedAtOffsetMinutes') ?? 0
    const endedAtMs = numberField(body.endedAtMs, 'endedAtMs')
    const endedAtOffsetMinutes = numberField(body.endedAtOffsetMinutes, 'endedAtOffsetMinutes')
    const value = numberField(body.value, 'value')
    const note = optionalTextField(body.note, 'note')

    const id = app.haelan.instance.events.add({
      personId, kind, startedAtMs, startedAtOffsetMinutes, endedAtMs, endedAtOffsetMinutes, value, note,
    })
    return reply.send({ id })
  })

  app.delete<{ Params: EventParams }>('/p/:personId/events/:eventId', async (request, reply) => {
    const personId = personIdOf(request)
    const eventId = request.params.eventId
    // No existence check first, unlike overrides' DELETE: EventStore carries no get() to check
    // against, and remove is already scoped by personId as well as id, so a missing or someone
    // else's event id does nothing rather than something. A 200 here says the id is gone, which
    // is true whether this call or an earlier one made it so.
    app.haelan.instance.events.remove({ personId, id: eventId })
    return reply.send({ id: eventId })
  })

  // The three list reads: notes, events and overrides. None of them paginates, and none of them
  // stamps its ETag off updated_at_ms the way the four daily backed reads do, for the same reason
  // the three tier 2 reads in tier2.ts do neither: see the two comments below and sendHashed.
  app.get<{ Params: PersonParams, Querystring: DateRangeQuery }>('/p/:personId/notes', async (request, reply) => {
    const personId = personIdOf(request)
    const { from, to } = requireDateRange(request.query)

    // Not paginated, deliberately: the schema's own unique constraint is one note per person per
    // local day, so a year in range is at most 365 rows and a cursor would add pagination's own
    // machinery, and its own defects, to a list that structurally cannot grow past that. See
    // paginate in tier2.ts for the shape this route is declining to copy a fourth time.
    const items = app.haelan.instance.notes.listFor(personId, from, to)
    return sendHashed(reply, request, { items })
  })

  app.get<{ Params: PersonParams, Querystring: DateRangeQuery }>('/p/:personId/events', async (request, reply) => {
    const personId = personIdOf(request)
    const { from, to } = requireDateRange(request.query)

    // EventStore.listFor takes local dates and does the widening and per-row narrowing itself
    // (see its own comment for why both exist); this route is validation plus the one call.
    const items = app.haelan.instance.events.listFor(personId, from, to)

    // Not paginated, deliberately: events are entered by hand, same as overrides below, so a
    // range wide enough to matter for pagination is not a range a person filled by hand.
    return sendHashed(reply, request, { items })
  })

  app.get<{ Params: PersonParams }>('/p/:personId/overrides', async (request, reply) => {
    const personId = personIdOf(request)

    // No from/to here, unlike the two routes above: OverrideStore.listFor takes no range, and
    // StoredOverride carries no date-like field a route could filter on without decoding a
    // sample key, a session id and a day_metric date three different ways to recover one. The
    // management list this feeds wants every correction for the person regardless, so this
    // returns all of them, not paginated for the same reason as above: overrides are entered by
    // hand and are fewer than notes.
    const items = app.haelan.instance.overrides.listFor(personId).map(roundCorrectedValue)
    return sendHashed(reply, request, { items })
  })
}

/**
 * A correcting override's correctedValue is a raw reading in its own target's unit, the same
 * figure /series rounds at its own boundary; a reader of this list deserves the same treatment,
 * not the 90.18407633664866 the bug report started from with a scope this route can name instead.
 *
 * Only a sample scope override can carry one at all: validate() above refuses `correct` at any
 * other scope, so metric-agnostic scopes (session, day_metric exclusions) never reach the try
 * block below. A sample target always names its metric too (parseSampleTarget throws if it does
 * not), so this never has to guess a precision the way a display with no server-side parse would.
 * The catch exists only for a row a rule written after this one predates, which must not turn a
 * list of someone's own corrections into a 500 over one unreadable row.
 */
function roundCorrectedValue(item: StoredOverride): StoredOverride {
  if (item.correctedValue === null || item.scope !== 'sample') return item
  try {
    const { metric } = parseSampleTarget(item.targetKey)
    return { ...item, correctedValue: roundMetricValue(metric, item.correctedValue) }
  } catch {
    return item
  }
}

/**
 * `from` and `to` both present, both real calendar dates, and not reversed. Shared by /notes and
 * /events, the two reads a caller ranges by local date, so the refusal a caller sees for a
 * malformed or backwards range cannot drift between the two the way three independent copies of
 * this check could.
 */
function requireDateRange(query: DateRangeQuery): { from: string, to: string } {
  const from = requireString(query.from, 'from')
  const to = requireString(query.to, 'to')
  requireDate('from', from)
  requireDate('to', to)
  if (from > to) throw new ConfigError(`from '${from}' is after to '${to}'`)
  return { from, to }
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
  drainPersonDerivation(app, personId)
  return { affected: { from: localDate, to: localDate }, applied: !stillQueued(app, personId, localDate) }
}

/**
 * Derives one person's queued days inside a request, within a real time budget.
 *
 * Shared with the companion ingest route: with no Google sync running for a person,
 * nothing else drains what an ingest marks, so without this the uploaded days would sit
 * queued and the dashboard would never show them. The budget and the rebuild quarantine
 * below are what make it safe to call from a request handler rather than a background job.
 *
 * Failures stay inside, the way SyncRunner#derive keeps its own: the write is committed
 * whatever happens here, and a 500 over saved rows invites the caller to send them a
 * second time. What the caller gets instead is `applied: false`, which is true.
 */
/**
 * `batch` is the granularity the DRAIN_BUDGET_MS check can preempt at, so a caller whose client is
 * holding a socket open should pass a smaller one than a caller whose is not.
 *
 * The companion ingest route learned this the expensive way. At the default of eight, a first sync
 * of thirty days of heart rate put eight dense days into one uninterruptible batch, the response
 * outran the phone's 30 second read timeout, and the app gave up on a request this server then
 * finished successfully. Nothing logged an error: the type simply said "never synced", and the
 * types queued behind it in that run were never attempted. Density decided which ones broke, so
 * the sparse types looked healthy throughout.
 */
export function drainPersonDerivation(
  app: FastifyInstance,
  personId: string,
  source = 'overrides',
  batchDays: number = DRAIN_BATCH_DAYS,
): void {
  const instance = app.haelan.instance

  // The gate SyncRunner#eligible puts in front of its own loop, and for the reason that method
  // records: a person whose boot rebuild failed carries tier 2 built by an older mapper, and
  // deriving their queued days now writes tier 3 at the current version on top of it. The runner
  // refuses to schedule that. An authenticated write must not be a second door to it. Returning
  // leaves the day queued, so the answer is applied false, which is true and needs no branch of
  // its own. A person who has vanished between the guard and here is nobody to derive either.
  const person = app.haelan.stores.people.get(personId)
  if (!person || peopleNeedingRebuild([person]).length > 0) return

  const startedAtMs = performance.now()
  try {
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch++) {
      const report = runDerive({
        db: instance.db,
        queue: instance.deriveQueue,
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: app.haelan.now(),
        batch: batchDays,
        // Scoped to the writer's own person. An unscoped drain would derive other people's dirty
        // days inside this request: work this caller did not ask for and, on a shared instance,
        // work about somebody else's data.
        personIds: [personId],
      })
      if (report.daysDerived === 0) return
      if (performance.now() - startedAtMs >= DRAIN_BUDGET_MS) {
        // Neither line claims anything about what is left queued. A final full batch can have
        // emptied the queue, and stillQueued asks a line later rather than guessing here.
        console.log(`${source}: derivation for ${personId} stopped at its ${DRAIN_BUDGET_MS}ms budget`)
        return
      }
    }
    console.log(`${source}: derivation for ${personId} stopped after ${MAX_DRAIN_BATCHES} batches`)
  } catch (error) {
    console.error(`${source}: derivation for ${personId} failed, ${messageOf(error)}`)
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

/** Like numberField, but absent is refused rather than passed through: an event needs a start. */
function requiredNumberField(value: unknown, name: string): number {
  if (value === undefined || value === null) throw new ConfigError(`${name} is required`)
  return numberField(value, name) as number
}

/**
 * An event's note is free text same as textField's, except an event without one is as valid as
 * one with, so absent is allowed through rather than refused.
 */
function optionalTextField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return textField(value, name)
}
