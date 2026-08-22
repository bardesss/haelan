import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { syncState } from '../db/schema/index.ts'
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
  recordSchemaDrift(input: { personId: string, dataType: string, points: number, nowMs: number }): void {
    const error = new SchemaDriftError(
      `${input.points} points fetched and none mapped to a row; the payload shape may have changed`,
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

  dueJobs(personIds: string[], _nowMs: number): SyncJob[] {
    return personIds.flatMap((personId) =>
      DATA_TYPES.filter((t) => t.listSupported).map((t) => ({ personId, dataType: t.id })))
  }

  private upsert(personId: string, dataType: string, set: Partial<typeof syncState.$inferInsert>): void {
    this.#db.insert(syncState).values({ personId, dataType, ...set })
      .onConflictDoUpdate({ target: [syncState.personId, syncState.dataType], set })
      .run()
  }
}
