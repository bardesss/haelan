import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { people } from '../db/schema/index.ts'

export interface PersonRow {
  id: string
  displayName: string
  timezone: string
  builtMappingVersion: number | null
  builtDerivationVersion: number | null
}

// The server needs a display name and a timezone and has no other reason to know what a table
// is. Spec section 6 keeps SQL inside core; this is the read that keeps it there.
export class PeopleStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  create(input: Omit<PersonRow, 'builtMappingVersion' | 'builtDerivationVersion'> & { nowMs: number }): PersonRow {
    this.#db.insert(people).values({
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      createdAtMs: input.nowMs,
    }).run()
    return {
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      builtMappingVersion: null,
      builtDerivationVersion: null,
    }
  }

  get(id: string): PersonRow | null {
    const row = this.#db.select().from(people).where(eq(people.id, id)).get()
    return row
      ? {
        id: row.id,
        displayName: row.displayName,
        timezone: row.timezone,
        builtMappingVersion: row.builtMappingVersion ?? null,
        builtDerivationVersion: row.builtDerivationVersion ?? null,
      }
      : null
  }

  list(): PersonRow[] {
    return this.#db.select().from(people).all()
      .map((row) => ({
        id: row.id,
        displayName: row.displayName,
        timezone: row.timezone,
        builtMappingVersion: row.builtMappingVersion ?? null,
        builtDerivationVersion: row.builtDerivationVersion ?? null,
      }))
  }

  count(): number {
    return this.#db.select().from(people).all().length
  }

  /**
   * Records what this person's derived rows were built with. Called inside the rebuild's own
   * transaction, so the stamp commits with the rows it describes and a crash between the two
   * cannot leave a person that looks rebuilt and is not.
   */
  stampBuiltVersions(input: { id: string, mappingVersion: number, derivationVersion: number }): void {
    this.#db.update(people)
      .set({ builtMappingVersion: input.mappingVersion, builtDerivationVersion: input.derivationVersion })
      .where(eq(people.id, input.id))
      .run()
  }

  // The wizard creates the person row before the account's foreign key can point at it, and
  // hashing is async, so a failed account leaves an orphan this undoes.
  remove(id: string): void {
    this.#db.delete(people).where(eq(people.id, id)).run()
  }
}
