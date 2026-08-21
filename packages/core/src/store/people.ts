import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { people } from '../db/schema/index.ts'

export interface PersonRow {
  id: string
  displayName: string
  timezone: string
}

// The server needs a display name and a timezone and has no other reason to know what a table
// is. Spec section 6 keeps SQL inside core; this is the read that keeps it there.
export class PeopleStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  create(input: PersonRow & { nowMs: number }): PersonRow {
    this.#db.insert(people).values({
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      createdAtMs: input.nowMs,
    }).run()
    return { id: input.id, displayName: input.displayName, timezone: input.timezone }
  }

  get(id: string): PersonRow | null {
    const row = this.#db.select().from(people).where(eq(people.id, id)).get()
    return row ? { id: row.id, displayName: row.displayName, timezone: row.timezone } : null
  }

  list(): PersonRow[] {
    return this.#db.select().from(people).all()
      .map((row) => ({ id: row.id, displayName: row.displayName, timezone: row.timezone }))
  }

  count(): number {
    return this.#db.select().from(people).all().length
  }

  // The wizard creates the person row before the account's foreign key can point at it, and
  // hashing is async, so a failed account leaves an orphan this undoes.
  remove(id: string): void {
    this.#db.delete(people).where(eq(people.id, id)).run()
  }
}
