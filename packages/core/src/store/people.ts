import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { people } from '../db/schema/index.ts'
import { MAPPING_VERSION } from '../api/version.ts'
import { DERIVATION_VERSION } from '../derive/version.ts'

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

  /**
   * Stamped at the current versions from the moment they exist, unlike the null columns a
   * person predating M2e carries.
   *
   * Not a shortcut: a person with no derived rows at all is consistent with every version there
   * has ever been, so the stamp is true the instant it is written. What it buys is that the
   * version columns mean one thing rather than two. Left null, a brand new person would be
   * indistinguishable from one whose rows were built by an older mapper, and everything that
   * reads the gate would treat them the same, which is exactly wrong in one specific way: the
   * sync runner skips a person who needs a rebuild, so a new person would be skipped and never
   * receive any data, and the rebuild only runs at boot, so somebody who connected afterwards
   * would never be un-skipped either. Stamping here is what makes "needs a rebuild" mean "has
   * rows built by something older" rather than "has rows, or does not, we cannot tell".
   */
  create(input: Omit<PersonRow, 'builtMappingVersion' | 'builtDerivationVersion'> & { nowMs: number }): PersonRow {
    this.#db.insert(people).values({
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      createdAtMs: input.nowMs,
      builtMappingVersion: MAPPING_VERSION,
      builtDerivationVersion: DERIVATION_VERSION,
    }).run()
    return {
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      builtMappingVersion: MAPPING_VERSION,
      builtDerivationVersion: DERIVATION_VERSION,
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
