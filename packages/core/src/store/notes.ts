import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { notes } from '../db/schema/index.ts'

export interface PutNoteInput { personId: string, localDate: string, body: string, nowMs: number }
export interface StoredNote { id: string, localDate: string, body: string, updatedAtMs: number }

/**
 * Free text a person attaches to one of their own local days.
 *
 * Unlike OverrideStore beside it, this takes no DeriveQueue and marks nothing dirty. An override
 * changes what a derivation computes; a note changes no number at all, it is commentary next to
 * the numbers, so there is no day for a derivation to recompute and nothing to queue.
 */
export class NoteStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) {
    this.#db = db
  }

  // The schema's own unique constraint is on (personId, localDate), so a second write for a day
  // already noted is an edit, not a new row: this upserts on that pair rather than inserting blind.
  put(input: PutNoteInput): string {
    const id = randomUUID()
    this.#db.insert(notes).values({
      id,
      personId: input.personId,
      localDate: input.localDate,
      body: input.body,
      updatedAtMs: input.nowMs,
    }).onConflictDoUpdate({
      target: [notes.personId, notes.localDate],
      set: { body: input.body, updatedAtMs: input.nowMs },
    }).run()
    return id
  }

  remove(input: { personId: string, localDate: string }): void {
    this.#db.delete(notes).where(and(
      eq(notes.personId, input.personId),
      eq(notes.localDate, input.localDate),
    )).run()
  }

  listFor(personId: string, from: string, to: string): StoredNote[] {
    return this.#db.select().from(notes).where(and(
      eq(notes.personId, personId),
      gte(notes.localDate, from),
      lte(notes.localDate, to),
    )).orderBy(asc(notes.localDate)).all()
      .map((row) => ({
        id: row.id,
        localDate: row.localDate,
        body: row.body,
        updatedAtMs: row.updatedAtMs,
      }))
  }
}
