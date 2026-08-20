import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { syncState } from '../db/schema/index.ts'
import { DATA_TYPES } from '../api/catalogue.ts'

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
  constructor(private readonly db: DbOrTx) {}

  get(personId: string, dataType: string): SyncStateRow | null {
    const row = this.db.select().from(syncState)
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

  setBackfillCursor(input: { personId: string, dataType: string, cursorMs: number, nowMs: number }): void {
    this.upsert(input.personId, input.dataType, { backfillCursorMs: input.cursorMs })
  }

  markBackfillComplete(input: { personId: string, dataType: string, nowMs: number }): void {
    this.upsert(input.personId, input.dataType, { backfillCompleteAtMs: input.nowMs })
  }

  dueJobs(personIds: string[], _nowMs: number): SyncJob[] {
    return personIds.flatMap((personId) =>
      DATA_TYPES.filter((t) => t.listSupported).map((t) => ({ personId, dataType: t.id })))
  }

  private upsert(personId: string, dataType: string, set: Partial<typeof syncState.$inferInsert>): void {
    this.db.insert(syncState).values({ personId, dataType, ...set })
      .onConflictDoUpdate({ target: [syncState.personId, syncState.dataType], set })
      .run()
  }
}
