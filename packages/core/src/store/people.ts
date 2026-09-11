import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { people } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'
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
   * The name this person is called on their own pages. Nothing else depends on it: no index, no
   * derived row and no join, which is why this is the one profile field that changes and costs
   * nothing.
   */
  setDisplayName(id: string, displayName: string): void {
    const trimmed = displayName.trim()
    if (trimmed === '') throw new ConfigError('a name is required')
    this.#db.update(people).set({ displayName: trimmed }).where(eq(people.id, id)).run()
  }

  /**
   * Moves this person's day boundary, and marks everything derived under the old one as stale.
   *
   * The second half is not housekeeping. Day boundaries are computed here rather than in UTC
   * (see the column's own comment, and spec invariant 3), and `daily` is keyed by the local date
   * the old zone produced, so the instant this column changes every derived row for this person
   * is filed under a day that is no longer theirs. Nothing recomputes on read.
   *
   * So the derivation stamp is cleared in the same statement as the zone. That is the existing
   * record of "this person's tiers 2 and 3 were built by something that no longer applies", the
   * one `peopleNeedingRebuild` already reads and the boot rebuild already acts on, and clearing
   * it here needs no second mechanism to remember what this change owes. The mapping stamp is
   * left alone: tier 1 is archived payloads mapped to samples and carries no local date at all,
   * so it is not what went stale, and `runRebuild` replays a person in full for either reason
   * regardless.
   *
   * One statement rather than two, because a timezone written without the stamp cleared is the
   * one state nothing downstream can detect: a person whose rows silently disagree with their
   * own day boundary and whose stamp says they are current.
   */
  setTimezone(id: string, timezone: string): void {
    this.#db.update(people)
      .set({ timezone, builtDerivationVersion: null })
      .where(eq(people.id, id))
      .run()
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
