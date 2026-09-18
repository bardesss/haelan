import { asc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { rebuildDrops, rebuildState } from '../db/schema/index.ts'

// Incremented in SQL rather than read-then-written: two boots racing on the same row would
// otherwise both read the same number and both write one more than it.
const sqlIncrement = () => sql`${rebuildState.consecutiveFailures} + 1`

export interface RebuildDrop {
  dataType: string
  reason: string
  pages: number
}

export interface RebuildStateRow {
  personId: string
  lastAttemptAtMs: number | null
  lastSuccessAtMs: number | null
  lastErrorAtMs: number | null
  lastError: string | null
  consecutiveFailures: number
  droppedPages: number
  drops: RebuildDrop[]
}

/**
 * What the last rebuild of each person did, and what it could not replay.
 *
 * MUST be called from outside the person's rebuild transaction. better-sqlite3 runs one
 * connection, so every statement issued while a transaction callback executes joins that
 * transaction - the same property runRebuild relies on deliberately for its version stamp. Here
 * it is the hazard rather than the mechanism: the failure path exists to record a transaction
 * that rolled back, and a write enlisted in it would roll back too, leaving no trace of the very
 * thing it was recording. runRebuild therefore calls recordFailure from its catch and
 * recordSuccess after the commit, never from inside the callback.
 */
export class RebuildStateStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) {
    this.#db = db
  }

  get(personId: string): RebuildStateRow | null {
    const row = this.#db.select().from(rebuildState)
      .where(eq(rebuildState.personId, personId)).get()
    if (row === undefined) return null
    return { ...row, drops: this.#dropsFor(personId) }
  }

  all(): RebuildStateRow[] {
    return this.#db.select().from(rebuildState)
      .orderBy(asc(rebuildState.personId)).all()
      .map((row) => ({ ...row, drops: this.#dropsFor(row.personId) }))
  }

  recordSuccess(input: {
    personId: string, nowMs: number, droppedPages: number, drops: readonly RebuildDrop[],
  }): void {
    this.#db.transaction((tx) => {
      tx.insert(rebuildState).values({
        personId: input.personId,
        lastAttemptAtMs: input.nowMs,
        lastSuccessAtMs: input.nowMs,
        consecutiveFailures: 0,
        droppedPages: input.droppedPages,
      }).onConflictDoUpdate({
        target: rebuildState.personId,
        set: {
          lastAttemptAtMs: input.nowMs,
          lastSuccessAtMs: input.nowMs,
          // Zeroed rather than left standing. A rebuild that committed is not a failed rebuild,
          // even when it dropped pages, and a stale count beside a fresh success would read as
          // "still broken" to whoever is deciding whether their upgrade worked.
          consecutiveFailures: 0,
          droppedPages: input.droppedPages,
        },
      }).run()
      // Replaced wholesale, so the table always describes the most recent attempt. Inside this
      // transaction rather than as two statements, so a reader never sees the gap between the
      // delete and the insert.
      tx.delete(rebuildDrops).where(eq(rebuildDrops.personId, input.personId)).run()
      for (const drop of input.drops) {
        tx.insert(rebuildDrops).values({ personId: input.personId, ...drop }).run()
      }
    })
  }

  recordFailure(input: { personId: string, nowMs: number, error: string }): void {
    // The drops of a rolled-back attempt are deliberately left alone. The attempt wrote nothing,
    // so whatever the last completed rebuild found is still the truest thing on file.
    this.#db.insert(rebuildState).values({
      personId: input.personId,
      lastAttemptAtMs: input.nowMs,
      lastErrorAtMs: input.nowMs,
      lastError: input.error,
      consecutiveFailures: 1,
    }).onConflictDoUpdate({
      target: rebuildState.personId,
      set: {
        lastAttemptAtMs: input.nowMs,
        lastErrorAtMs: input.nowMs,
        lastError: input.error,
        consecutiveFailures: sqlIncrement(),
      },
    }).run()
  }

  #dropsFor(personId: string): RebuildDrop[] {
    return this.#db.select({
      dataType: rebuildDrops.dataType, reason: rebuildDrops.reason, pages: rebuildDrops.pages,
    }).from(rebuildDrops).where(eq(rebuildDrops.personId, personId))
      .orderBy(asc(rebuildDrops.dataType), asc(rebuildDrops.reason)).all()
  }
}
