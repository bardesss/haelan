import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { deriveQueue } from '../db/schema/index.ts'
import { shiftLocalDate } from '../derive/localDay.ts'

export interface QueueEntry { personId: string, localDate: string }

/**
 * Which person-days need recomputing. Written by anything that invalidates a day: sync as it
 * commits a window, an override as it is added or removed, and a derivation_version bump, which
 * is what a rebuild is. Drained by runDerive.
 */
export class DeriveQueue {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) {
    this.#db = db
  }

  /**
   * `tx` lets a caller enrol the mark in a transaction it already opened, so a window's rows
   * and the fact that its day is dirty commit or roll back together. A day marked for rows that
   * were rolled back would derive from data that is not there.
   */
  markDirty(input: QueueEntry & { nowMs: number }, tx: DbOrTx = this.#db): void {
    tx.insert(deriveQueue).values({
      personId: input.personId, localDate: input.localDate, queuedAtMs: input.nowMs,
    }).onConflictDoNothing().run()
  }

  markRange(input: { personId: string, fromLocalDate: string, toLocalDate: string, nowMs: number }): void {
    for (const localDate of datesBetween(input.fromLocalDate, input.toLocalDate)) {
      this.markDirty({ personId: input.personId, localDate, nowMs: input.nowMs })
    }
  }

  /**
   * Oldest first, and it does not remove what it hands back. A day stays queued until `clear`
   * says its rows are committed, so a crash mid-derive costs a repeat rather than a day that
   * silently never derived.
   *
   * `personIds` narrows the claim, which is how the sync runner's quarantine reaches the drain.
   * Filtering here rather than after the fact matters: a batch discarded in the caller would
   * report nothing derived and stall the drain loop while other people still had work queued.
   * Omitted means every person, which is what the rebuild and the tests want.
   */
  claim(limit: number, personIds?: readonly string[]): QueueEntry[] {
    if (personIds !== undefined && personIds.length === 0) return []
    return this.#db.select({ personId: deriveQueue.personId, localDate: deriveQueue.localDate })
      .from(deriveQueue)
      .where(personIds === undefined ? undefined : inArray(deriveQueue.personId, [...personIds]))
      .orderBy(asc(deriveQueue.queuedAtMs), asc(deriveQueue.personId), asc(deriveQueue.localDate))
      .limit(limit)
      .all()
  }

  /**
   * `tx` for the same reason `markDirty` takes one: runDerive clears inside the transaction that
   * wrote the day's rows, so a crash between the two cannot leave a day that looks derived and
   * is not.
   */
  clear(entries: ReadonlyArray<QueueEntry>, tx: DbOrTx = this.#db): void {
    for (const entry of entries) {
      tx.delete(deriveQueue)
        .where(and(eq(deriveQueue.personId, entry.personId), eq(deriveQueue.localDate, entry.localDate)))
        .run()
    }
  }

  size(): number {
    const row = this.#db.select({ n: sql<number>`count(*)` }).from(deriveQueue).get()
    return row?.n ?? 0
  }
}

// The stepping itself lives in localDay.ts, which is the module that owns day arithmetic.
function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let date = from; date <= to; date = shiftLocalDate(date, 1)) out.push(date)
  return out
}
