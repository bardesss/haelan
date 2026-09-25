import { and, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { syncState, excludedDataTypes } from '../db/schema/index.ts'
import { DATA_TYPES } from '../api/catalogue.ts'
import { SchemaDriftError } from '../errors.ts'

export interface SyncJob { personId: string, dataType: string }

export interface SyncStateRow {
  highWaterMs: number | null
  backfillCursorMs: number | null
  backfillCompleteAtMs: number | null
  lastSuccessAtMs: number | null
  lastErrorAtMs: number | null
  lastError: string | null
  consecutiveFailures: number
}

/** One data type failing for a person right now - statusPanel.ts's StatusFailure, structurally. */
export interface SyncFailure {
  dataType: string
  lastError: string | null
  lastErrorAtMs: number | null
}

/** What the members list says about one person's sync, and the only aggregate over sync_state
 *  anything outside this store asks for. */
export interface SyncFreshness {
  /** The oldest last-success across the types this person syncs; null when one has never run. */
  oldestSuccessAtMs: number | null
  /** How many of those types have never succeeded. */
  neverSucceeded: number
  /** How many are failing right now, by their own consecutive-failure count. */
  failing: number
  /** How many types this person syncs at all - the denominator for both counts above. */
  due: number
}

export class SyncStateStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  get(personId: string, dataType: string): SyncStateRow | null {
    const row = this.#db.select().from(syncState)
      .where(and(eq(syncState.personId, personId), eq(syncState.dataType, dataType))).get()
    if (!row) return null
    return {
      highWaterMs: row.highWaterMs ?? null,
      backfillCursorMs: row.backfillCursorMs ?? null,
      backfillCompleteAtMs: row.backfillCompleteAtMs ?? null,
      lastSuccessAtMs: row.lastSuccessAtMs ?? null,
      lastErrorAtMs: row.lastErrorAtMs ?? null,
      lastError: row.lastError ?? null,
      consecutiveFailures: row.consecutiveFailures,
    }
  }

  recordSuccess(input: { personId: string, dataType: string, highWaterMs: number, nowMs: number }): void {
    const existing = this.get(input.personId, input.dataType)
    // The trailing window revisits days already synced, so a run can legitimately report a mark
    // behind the stored one. Taking the max keeps the cursor monotonic.
    const highWaterMs = Math.max(input.highWaterMs, existing?.highWaterMs ?? Number.NEGATIVE_INFINITY)
    this.upsert(input.personId, input.dataType, {
      highWaterMs, lastSuccessAtMs: input.nowMs, consecutiveFailures: 0,
    })
  }

  recordFailure(input: { personId: string, dataType: string, error: Error, nowMs: number }): void {
    const existing = this.get(input.personId, input.dataType)
    this.upsert(input.personId, input.dataType, {
      lastErrorAtMs: input.nowMs,
      lastError: String(input.error.message).slice(0, 500),
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
    })
  }

  // The client deliberately does not archive the bodies of retries it recovered from, on the
  // grounds that they are operational noise rather than tier 1 truth. This is where they land
  // instead, so a slow sync is diagnosable without them.
  recordRetryEpisode(input: { personId: string, dataType: string, attempts: number, lastStatus: number, nowMs: number }): void {
    this.upsert(input.personId, input.dataType, {
      lastErrorAtMs: input.nowMs,
      lastError: `[transient] recovered after ${input.attempts} attempts, last status ${input.lastStatus}`,
    })
  }

  // Spec section 13's "log", for the one failure mode that raises no error at all: every page
  // arrived, every point parsed as a point, and not one of them produced a row. Deliberately not
  // recordFailure - consecutiveFailures is untouched - because the fetch and the archive both
  // worked. Backing off would stop the archive filling, which is the part still going right, and
  // the archived payloads are what make this recoverable by rebuild once the mapping is fixed.
  /**
   * `reason` distinguishes the two ways a payload can stop making sense: points that mapped to
   * no rows, which means a value path moved, and a body we could not read at all, which means
   * the envelope itself did. They need different fixes, so the record has to say which.
   */
  recordSchemaDrift(input: {
    personId: string, dataType: string, points: number, nowMs: number, reason?: string,
  }): void {
    const error = new SchemaDriftError(
      input.reason
        ? `${input.reason}; the payload shape may have changed`
        : `${input.points} points fetched and none mapped to a row; the payload shape may have changed`,
    )
    this.upsert(input.personId, input.dataType, {
      lastErrorAtMs: input.nowMs,
      lastError: error.message.slice(0, 500),
    })
  }

  setBackfillCursor(input: { personId: string, dataType: string, cursorMs: number, nowMs: number }): void {
    this.upsert(input.personId, input.dataType, { backfillCursorMs: input.cursorMs })
  }

  markBackfillComplete(input: { personId: string, dataType: string, nowMs: number }): void {
    this.upsert(input.personId, input.dataType, { backfillCompleteAtMs: input.nowMs })
  }

  // The inverse of markBackfillComplete, for a horizon raised past a floor a type already
  // finished at. It touches nothing but the mark: the cursor stays where it was and nothing
  // archived is deleted, so runBackfill just resumes walking from it. If the cursor is already
  // past the new floor too, runBackfill re-marks the type complete on its very next call, which
  // is what makes clearing safe to call even when it turns out to be a no-op.
  clearBackfillComplete(personId: string, dataType: string): void {
    this.upsert(personId, dataType, { backfillCompleteAtMs: null })
  }

  /**
   * A job for a type this person turned off is not due, so the exclusion is read here rather
   * than trusted to every caller of dueJobs to apply for itself. Queried against
   * excluded_data_types directly instead of taking an ExcludedDataTypeStore: this store already
   * holds the db handle the query needs, the two tables live in the same schema file for exactly
   * this kind of read, and a constructor dependency would have to be threaded through every
   * existing SyncStateStore call site (apps/server's wiring and four test files) for a query this
   * store can already run itself.
   *
   * One query across every requested person rather than one per person, so a household sync does
   * not pay for a round trip per member. Grouped back out per person below because an exclusion
   * is never allowed to leak from one person's set to another's jobs.
   */
  dueJobs(personIds: string[], _nowMs: number): SyncJob[] {
    if (personIds.length === 0) return []
    const excludedRows = this.#db.select({
      personId: excludedDataTypes.personId, dataTypeId: excludedDataTypes.dataTypeId,
    }).from(excludedDataTypes).where(inArray(excludedDataTypes.personId, personIds)).all()
    const excludedByPerson = new Map<string, Set<string>>()
    for (const row of excludedRows) {
      const set = excludedByPerson.get(row.personId) ?? new Set<string>()
      set.add(row.dataTypeId)
      excludedByPerson.set(row.personId, set)
    }
    return personIds.flatMap((personId) => {
      const excluded = excludedByPerson.get(personId) ?? new Set<string>()
      return DATA_TYPES.filter((t) => t.actions.length > 0 && !excluded.has(t.id))
        .map((t) => ({ personId, dataType: t.id }))
    })
  }

  /**
   * How fresh a person's data actually is, for the members list.
   *
   * The floor, not the ceiling. A maximum over a person's types reads "synced two minutes ago"
   * while sleep has been failing since Tuesday, because steps synced two minutes ago - flattering,
   * and wrong in the one direction that matters. `oldestSuccessAtMs` is the oldest last-success
   * across the types this person still syncs, so it cannot be newer than the least fresh thing on
   * their pages, and it is null when any of those types has never succeeded at all: the floor
   * under "never" is never.
   *
   * Over the same set dueJobs walks - a type with no actions is not fetched, and a type the person
   * turned off is not theirs to be behind on - read here the same way and for the same reason, so
   * one person's exclusions can never colour another's figure.
   *
   * The two counts beside it are what the timestamp cannot say: a single figure cannot distinguish
   * an instance that is quietly fine from one where three types have been failing for a week, and
   * "failing" is the story an admin looking at this list is actually after.
   */
  freshnessFor(personIds: string[]): Map<string, SyncFreshness> {
    const result = new Map<string, SyncFreshness>()
    if (personIds.length === 0) return result
    const stateRows = this.#db.select().from(syncState)
      .where(inArray(syncState.personId, personIds)).all()
    const byPerson = new Map<string, Map<string, typeof stateRows[number]>>()
    for (const row of stateRows) {
      const forPerson = byPerson.get(row.personId) ?? new Map()
      forPerson.set(row.dataType, row)
      byPerson.set(row.personId, forPerson)
    }
    // dueJobs already answers "which types is this person syncing", exclusions and all, and asking
    // it is what keeps that rule in one place rather than in two that can drift.
    const dueByPerson = new Map<string, string[]>()
    for (const job of this.dueJobs(personIds, 0)) {
      dueByPerson.set(job.personId, [...(dueByPerson.get(job.personId) ?? []), job.dataType])
    }
    for (const personId of personIds) {
      const due = dueByPerson.get(personId) ?? []
      const rows = byPerson.get(personId) ?? new Map()
      let oldest: number | null = null
      let neverSucceeded = 0
      let failing = 0
      for (const dataType of due) {
        const row = rows.get(dataType)
        const success = row?.lastSuccessAtMs ?? null
        if (success === null) neverSucceeded += 1
        else if (oldest === null || success < oldest) oldest = success
        if ((row?.consecutiveFailures ?? 0) > 0) failing += 1
      }
      result.set(personId, {
        oldestSuccessAtMs: neverSucceeded > 0 ? null : oldest,
        neverSucceeded,
        failing,
        due: due.length,
      })
    }
    return result
  }

  /**
   * The data types failing for one person right now, each with the last error sync_state kept for
   * it, for the status panel's "what failed" list. In no particular order: composeStatus orders it.
   *
   * Exactly the set freshnessFor counts as `failing` - a type this person syncs (dueJobs, so an
   * excluded type is not theirs to be failing on) whose consecutiveFailures is above zero - and
   * built the same way on purpose. The panel prints a count beside the list, and the members page
   * prints freshnessFor's count for the same person; the two drifting apart would put two answers
   * to one question on two screens. `lastError` alone is not the test: a type that failed and then
   * recovered keeps its old message, and consecutiveFailures is what records that it recovered.
   */
  failuresFor(personId: string): SyncFailure[] {
    const due = new Set(this.dueJobs([personId], 0).map((job) => job.dataType))
    return this.#db.select({
      dataType: syncState.dataType,
      lastError: syncState.lastError,
      lastErrorAtMs: syncState.lastErrorAtMs,
      consecutiveFailures: syncState.consecutiveFailures,
    }).from(syncState).where(eq(syncState.personId, personId)).all()
      .filter((row) => row.consecutiveFailures > 0 && due.has(row.dataType))
      .map((row) => ({ dataType: row.dataType, lastError: row.lastError ?? null, lastErrorAtMs: row.lastErrorAtMs ?? null }))
  }

  private upsert(personId: string, dataType: string, set: Partial<typeof syncState.$inferInsert>): void {
    this.#db.insert(syncState).values({ personId, dataType, ...set })
      .onConflictDoUpdate({ target: [syncState.personId, syncState.dataType], set })
      .run()
  }
}
