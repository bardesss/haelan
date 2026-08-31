import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { overrides, samples, sessions } from '../db/schema/index.ts'
import type { DeriveQueue } from './deriveQueue.ts'
import { ConfigError } from '../errors.ts'
import { localDateOf } from '../derive/localDay.ts'
import { parseDayMetricTarget, parseSampleTarget, parseSessionTarget } from '../derive/targetKey.ts'
import type { OverrideScope } from '../derive/targetKey.ts'
import type { OverrideLike } from '../derive/overrides.ts'

export interface PutOverrideInput {
  personId: string
  scope: OverrideScope
  targetKey: string
  action: 'exclude' | 'correct'
  correctedValue?: number
  reason: string
  nowMs: number
}

export type StoredOverride = OverrideLike & { id: string, reason: string }

/**
 * Overrides are tier 1: a person's own correction is durable truth, not something a rebuild
 * regenerates. Writing one marks the days it affects so the derivation that applies it runs, and
 * removing one marks them again, which is what makes removal restore the original exactly.
 */
export class OverrideStore {
  readonly #db: DbOrTx

  readonly #queue: DeriveQueue

  constructor(db: DbOrTx, queue: DeriveQueue) {
    this.#db = db
    this.#queue = queue
  }

  put(input: PutOverrideInput): string {
    validate(input)
    const id = randomUUID()
    this.#db.transaction((tx) => {
      tx.insert(overrides).values({
        id,
        personId: input.personId,
        scope: input.scope,
        targetKey: input.targetKey,
        action: input.action,
        correctedValue: input.correctedValue ?? null,
        reason: input.reason,
        createdAtMs: input.nowMs,
      }).run()
      this.#markAffected(tx, input.personId, input.scope, input.targetKey, input.nowMs)
    })
    return id
  }

  remove(input: { personId: string, id: string, nowMs: number }): void {
    this.#db.transaction((tx) => {
      // Scoped by personId as well as id: an id is not a secret, and master design section 15
      // is that an account sees and touches only its own data. Without this, holding another
      // person's override id would delete their override and requeue their day.
      const owned = and(eq(overrides.id, input.id), eq(overrides.personId, input.personId))
      const row = tx.select().from(overrides).where(owned).get()
      if (!row) return
      tx.delete(overrides).where(owned).run()
      // Read before delete, and mark after: the day has to be recomputed without the override,
      // and the row is the only place its target was recorded.
      this.#markAffected(tx, row.personId, row.scope, row.targetKey, input.nowMs)
    })
  }

  listFor(personId: string): StoredOverride[] {
    return this.#db.select().from(overrides).where(eq(overrides.personId, personId)).all()
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        targetKey: row.targetKey,
        action: row.action,
        correctedValue: row.correctedValue ?? null,
        reason: row.reason,
      }))
  }

  /**
   * Which local day a target falls on, or null when nothing names one yet.
   *
   * The same answer `#markAffected` marks the queue with, exposed because a caller that writes an
   * override has to say which day it touched and then ask whether that day is still queued. A
   * second copy of this resolution in the route would be a day reported that could disagree with
   * the day marked, which is the one disagreement nobody would notice.
   */
  affectedLocalDate(input: { personId: string, scope: OverrideScope, targetKey: string }): string | null {
    return this.#localDateOf(this.#db, input.personId, input.scope, input.targetKey)
  }

  #markAffected(tx: DbOrTx, personId: string, scope: OverrideScope, targetKey: string, nowMs: number): void {
    const localDate = this.#localDateOf(tx, personId, scope, targetKey)
    // Nothing to mark is an ordinary answer: an override can be written before a backfill has
    // reached the day it targets, and the sync that writes those rows marks the day itself.
    if (localDate === null) return
    this.#queue.markDirty({ personId, localDate, nowMs }, tx)
  }

  #localDateOf(tx: DbOrTx, personId: string, scope: OverrideScope, targetKey: string): string | null {
    if (scope === 'day_metric') return parseDayMetricTarget(targetKey).localDate

    if (scope === 'session') {
      const target = parseSessionTarget(targetKey)
      const row = tx.select({ localDate: sessions.localDate }).from(sessions)
        .where(and(eq(sessions.id, target), eq(sessions.personId, personId))).get()
      return row?.localDate ?? null
    }

    const target = parseSampleTarget(targetKey)
    // The row's own offset, never the person's current timezone: the offset in force at that
    // instant is what decides which local day the reading belongs to.
    const row = tx.select({ tzOffsetMinutes: samples.tzOffsetMinutes }).from(samples).where(and(
      eq(samples.personId, personId),
      eq(samples.sourceId, target.source),
      eq(samples.metric, target.metric),
      eq(samples.utcMs, target.utcMs),
    )).get()
    return row ? localDateOf(target.utcMs, row.tzOffsetMinutes) : null
  }
}

function validate(input: PutOverrideInput): void {
  // Parsing is the validation: each parser throws a ConfigError when the key is not the shape
  // its scope promises, which is how a key built by hand fails at write time rather than at
  // derivation time, where it would look like a day with no override at all.
  if (input.scope === 'sample') parseSampleTarget(input.targetKey)
  else if (input.scope === 'session') parseSessionTarget(input.targetKey)
  else parseDayMetricTarget(input.targetKey)

  if (input.action === 'correct' && input.scope !== 'sample') {
    throw new ConfigError(
      `a ${input.scope} override can only exclude: a corrected figure at that scope names none of `
      + 'the values derived from it, and nothing per source to be inspected against',
    )
  }
  if (input.action === 'correct' && input.correctedValue === undefined) {
    throw new ConfigError('a correcting override needs a corrected value')
  }
  if (input.action === 'exclude' && input.correctedValue !== undefined) {
    throw new ConfigError('an excluding override cannot carry a corrected value')
  }
}
