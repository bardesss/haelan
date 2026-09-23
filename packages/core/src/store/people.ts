import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { people } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'
import { DEFAULT_SLEEP_TARGET_MINUTES, SLEEP_TARGET_MINUTES_RANGE } from '../derive/metrics.ts'
import { MAPPING_VERSION } from '../api/version.ts'
import { DERIVATION_VERSION } from '../derive/version.ts'

export interface PersonRow {
  id: string
  displayName: string
  timezone: string
  birthDate: string | null
  sex: 'male' | 'female' | null
  companionPath: boolean
  sleepTargetMinutes: number
  sleepUseBaseline: boolean
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
  create(
    input: Omit<PersonRow, 'birthDate' | 'sex' | 'sleepTargetMinutes' | 'sleepUseBaseline' | 'builtMappingVersion'
      | 'builtDerivationVersion' | 'companionPath'>
      & { nowMs: number, companionPath?: boolean },
  ): PersonRow {
    this.#db.insert(people).values({
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      companionPath: input.companionPath ?? false,
      // The sleep target is left to the column's own default rather than written here: 480 is a
      // fact about the schema (see the column's own comment), and repeating it in this insert
      // would make two places to change it and one of them silent.
      createdAtMs: input.nowMs,
      builtMappingVersion: MAPPING_VERSION,
      builtDerivationVersion: DERIVATION_VERSION,
    }).run()
    return {
      id: input.id,
      displayName: input.displayName,
      timezone: input.timezone,
      birthDate: null,
      sex: null,
      companionPath: input.companionPath ?? false,
      sleepTargetMinutes: DEFAULT_SLEEP_TARGET_MINUTES,
      // The column's own default, restated: the insert above leaves it to the schema, and this
      // return states what that default is. upgrade-rehearsal.test.ts holds the schema default
      // against the migration's, and the default test below holds this return against both, so
      // the three cannot drift to three answers.
      sleepUseBaseline: true,
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
        birthDate: row.birthDate ?? null,
        sex: row.sex ?? null,
        companionPath: row.companionPath ?? false,
        sleepTargetMinutes: row.sleepTargetMinutes,
        sleepUseBaseline: row.sleepUseBaseline,
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
        birthDate: row.birthDate ?? null,
        sex: row.sex ?? null,
        companionPath: row.companionPath ?? false,
        sleepTargetMinutes: row.sleepTargetMinutes,
        sleepUseBaseline: row.sleepUseBaseline,
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
   * A birthday, or null to clear it.
   *
   * Cheap, like setDisplayName and unlike setTimezone: nothing derived reads this column. See the
   * schema's own comment for why that is true and what would make it stop being true.
   */
  setBirthDate(id: string, birthDate: string | null): void {
    if (birthDate !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        throw new ConfigError(`a birthday must be written YYYY-MM-DD, got '${birthDate}'`)
      }
      // Checked against a real calendar, not only against the shape: '1985-02-31' matches the
      // pattern above and is not a day.
      const parsed = new Date(`${birthDate}T00:00:00Z`)
      if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(birthDate)) {
        throw new ConfigError(`'${birthDate}' is not a date`)
      }
      // A birthday in the future is a typo every time, and it would make `ageAt` answer null and
      // Banister answer nothing, with no message saying why.
      if (parsed.getTime() > Date.now()) {
        throw new ConfigError('a birthday cannot be in the future')
      }
    }
    this.#db.update(people).set({ birthDate }).where(eq(people.id, id)).run()
  }

  /** Read for one thing only: Banister's coefficient, 1.92 or 1.67. Null to clear it. */
  setSex(id: string, sex: 'male' | 'female' | null): void {
    if (sex !== null && sex !== 'male' && sex !== 'female') {
      throw new ConfigError(`sex must be 'male' or 'female'`)
    }
    this.#db.update(people).set({ sex }).where(eq(people.id, id)).run()
  }

  /**
   * The nightly figure the sleep balance card measures a night against, once this person has no
   * baseline of their own to be measured against instead.
   *
   * Cheap, like setBirthDate and unlike setTimezone: nothing derived reads this column, so the
   * derivation stamp is deliberately not cleared here. The card computes at read time, from this
   * number and from whatever is already stored, so a change to it changes what the next page load
   * draws and nothing that has already been written. CONTRIBUTING asks a change like this for a
   * version bump first; this is the sentence saying why neither version moves.
   *
   * The range is enforced here rather than only in the form, because a route is reachable without
   * the form: 8 typed into a field that wanted minutes is a six times too long night, and a card
   * silently comparing every night against 8 minutes would state a surplus with nothing wrong on
   * screen to explain it.
   */
  setSleepTargetMinutes(id: string, minutes: number): void {
    if (!Number.isInteger(minutes)) {
      throw new ConfigError(`a sleep target must be whole minutes, got '${minutes}'`)
    }
    if (minutes < SLEEP_TARGET_MINUTES_RANGE.min || minutes > SLEEP_TARGET_MINUTES_RANGE.max) {
      throw new ConfigError(
        `a sleep target must be between ${SLEEP_TARGET_MINUTES_RANGE.min} and ${SLEEP_TARGET_MINUTES_RANGE.max} minutes, got ${minutes}`,
      )
    }
    this.#db.update(people).set({ sleepTargetMinutes: minutes }).where(eq(people.id, id)).run()
  }

  /**
   * Whether the sleep balance card may measure against this person's own usual once that is
   * worth standing on. Off means the stored target, always, for whoever wants to hold a seven
   * or eight hour line on purpose.
   *
   * Cheap in the same way setSleepTargetMinutes is: nothing derived reads this column, so the
   * derivation stamp is deliberately not cleared here either. The type is enforced here rather
   * than only in the form for the same reason the range is enforced there: a route is reachable
   * without the form, and a truthy string saved as a preference would read back as a boolean
   * the card could not trust.
   */
  setSleepUseBaseline(id: string, useBaseline: boolean): void {
    if (typeof useBaseline !== 'boolean') {
      throw new ConfigError(`whether to use the baseline must be a boolean, got '${useBaseline}'`)
    }
    this.#db.update(people).set({ sleepUseBaseline: useBaseline }).where(eq(people.id, id)).run()
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

  /**
   * Records this person's connection path choice. True means the phone
   * path, false means not. The Google path is recorded by the credentials row
   * instead, so this column never has to say both at once and never deduces a
   * choice from the absence of the other.
   */
  setCompanionPath(id: string, usesCompanion: boolean): void {
    this.#db.update(people).set({ companionPath: usesCompanion }).where(eq(people.id, id)).run()
  }

  // The wizard creates the person row before the account's foreign key can point at it, and
  // hashing is async, so a failed account leaves an orphan this undoes.
  remove(id: string): void {
    this.#db.delete(people).where(eq(people.id, id)).run()
  }
}
