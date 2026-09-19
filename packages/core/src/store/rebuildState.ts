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
          // Cleared for the same reason, and for a sharper one. The count is a number somebody
          // has to interpret; the error text is a sentence, rendered verbatim under its own
          // heading on both surfaces whenever this column is non-null, and nothing on either
          // screen says when it was captured. Left standing beside a fresh success it told a
          // person whose rebuild had just committed that their history had failed with a message
          // describing an attempt this one superseded. An error that is no longer the last thing
          // that happened is not an error anybody can act on, and tier 1 still holds whatever it
          // described, so there is nothing lost by forgetting it.
          //
          // This is also what makes the two timestamps mutually exclusive, which isQuarantined
          // below relies on.
          lastErrorAtMs: null,
          lastError: null,
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

/**
 * The last attempt errored and nothing has committed since. Exported and shared by the two
 * surfaces that ask, because a person warned about on one screen and clean on the other is
 * worse than either answer on its own.
 *
 * A non-null error timestamp is the whole test. This used to compare it against
 * lastSuccessAtMs, which was needed while recordSuccess left the error columns standing: the
 * two could then both be set and only their order said which came last. recordSuccess now
 * clears them, so an error timestamp survives only until the next attempt commits and its mere
 * presence already means "the last thing that happened was a failure". Dropping the comparison
 * also drops the tie it got wrong - a success and a failure landing in the same millisecond
 * left `lastSuccessAtMs < lastErrorAtMs` false and reported a real quarantine as clean.
 */
export function isQuarantined(row: RebuildStateRow | null | undefined): boolean {
  return row != null && row.lastErrorAtMs !== null
}
