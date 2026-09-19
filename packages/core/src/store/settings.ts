import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { instanceSettings } from '../db/schema/index.ts'
import type { ConsentPath } from '../db/schema/accounts.ts'
import { ConfigError } from '../errors.ts'
import type { AccountStore } from './accounts.ts'
import type { CredentialStore } from './credentials.ts'
import type { PeopleStore } from './people.ts'

const ROW_ID = 'default'

/** What an instance keeps and how often it takes one when nobody has said otherwise. */
export const DEFAULT_BACKUP_KEEP = 7
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24
// Ceilings rather than an open integer, which is what the environment variables these replaced
// had. A settings field is typed into by hand, and the two ways to get it wrong are a stray digit
// that fills the volume with copies and one that pushes the next backup past any horizon anybody
// would notice. A year of dailies and a year between backups are both past anything this is for.
const MAX_BACKUP_KEEP = 365
const MAX_BACKUP_INTERVAL_HOURS = 8760

/** How many completed backups to keep, and the hours between them. `keep` 0 turns backups off. */
export interface BackupPolicy {
  keep: number
  intervalHours: number
}

function assertKeep(keep: number): void {
  // Zero is not an oversight: it is how a household that backs the volume up by other means turns
  // this off, so the floor is zero rather than the one the interval below has.
  if (!Number.isInteger(keep) || keep < 0 || keep > MAX_BACKUP_KEEP) {
    throw new ConfigError(`backups to keep must be a whole number from 0 to ${MAX_BACKUP_KEEP}, got ${keep}`)
  }
}

function assertIntervalHours(hours: number): void {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_BACKUP_INTERVAL_HOURS) {
    throw new ConfigError(`hours between backups must be a whole number from 1 to ${MAX_BACKUP_INTERVAL_HOURS}, got ${hours}`)
  }
}

export interface InstanceSettingsRow {
  baseUrl: string
  consentPath: ConsentPath
  syncIntervalMinutes: number
  backfillHorizonDays: number
  setupCompletedAtMs: number | null
  sessionOverlapRatio: number
  nightGapMinutes: number
  /** Null until somebody chooses. See the column's own comment for why that state exists. */
  backupKeep: number | null
  backupIntervalHours: number | null
  /** Whether this instance may ask GitHub about newer releases. False until an admin says so. */
  updateCheckEnabled: boolean
  companionMode: boolean
}

export interface PutSettingsInput {
  baseUrl: string
  consentPath: ConsentPath
  syncIntervalMinutes?: number
  backfillHorizonDays?: number
  nowMs: number
}

export class SettingsStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  get(): InstanceSettingsRow | null {
    const row = this.#db.select().from(instanceSettings).where(eq(instanceSettings.id, ROW_ID)).get()
    if (!row) return null
    return {
      baseUrl: row.baseUrl,
      consentPath: row.consentPath,
      syncIntervalMinutes: row.syncIntervalMinutes,
      backfillHorizonDays: row.backfillHorizonDays,
      setupCompletedAtMs: row.setupCompletedAtMs ?? null,
      sessionOverlapRatio: row.sessionOverlapRatio,
      nightGapMinutes: row.nightGapMinutes,
      backupKeep: row.backupKeep ?? null,
      backupIntervalHours: row.backupIntervalHours ?? null,
      updateCheckEnabled: row.updateCheckEnabled,
      companionMode: row.companionMode,
    }
  }

  /**
   * The two backup numbers with their nulls resolved, which is what every caller that actually
   * takes or schedules a backup wants. Total on purpose: there is no settings row at all until
   * the wizard writes one, and the maintenance tick starts before that, so "no row" has to mean
   * the defaults rather than a crash or a skipped schedule.
   */
  backupPolicy(): BackupPolicy {
    const row = this.get()
    return {
      keep: row?.backupKeep ?? DEFAULT_BACKUP_KEEP,
      intervalHours: row?.backupIntervalHours ?? DEFAULT_BACKUP_INTERVAL_HOURS,
    }
  }

  put(input: PutSettingsInput): void {
    // The interval and the horizon are both omitted from the update when the caller did not
    // state them, so saving the URL from the wizard cannot silently reset a value chosen later.
    const set = {
      baseUrl: input.baseUrl,
      consentPath: input.consentPath,
      ...(input.syncIntervalMinutes === undefined ? {} : { syncIntervalMinutes: input.syncIntervalMinutes }),
      ...(input.backfillHorizonDays === undefined ? {} : { backfillHorizonDays: input.backfillHorizonDays }),
      updatedAtMs: input.nowMs,
    }
    this.#db.insert(instanceSettings)
      .values({ id: ROW_ID, syncIntervalMinutes: input.syncIntervalMinutes ?? 60, ...set })
      .onConflictDoUpdate({ target: instanceSettings.id, set })
      .run()
  }

  markSetupComplete(nowMs: number): void {
    this.#db.update(instanceSettings).set({ setupCompletedAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  // The companion app's way past the wizard: one update sets the flag and the completion
  // stamp together, so no reader ever sees a companion mode instance that is not finished.
  // The OAuth client and the consent stay absent, which is what setupStep reads below.
  completeCompanionSetup(nowMs: number): void {
    this.#db.update(instanceSettings)
      .set({ companionMode: true, setupCompletedAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  // Not put(): that takes the consent path alongside the URL, so a caller who only has a new
  // address would have to supply a consent path it never asked anybody about and would rewrite
  // the one chosen during setup. Same hazard put()'s own comment names one field up, a level
  // down: the update touches the two columns it is named for and no others.
  putBaseUrl(baseUrl: string, nowMs: number): void {
    this.#db.update(instanceSettings).set({ baseUrl, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  putBackfillHorizon(days: number, nowMs: number): void {
    this.#db.update(instanceSettings).set({ backfillHorizonDays: days, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  /**
   * Both numbers together, because the Maintenance card saves them together: writing one at a
   * time would leave the other null, and null is the state the one-time environment seed below
   * reads as "nobody has chosen yet". A half-chosen policy would get half-overwritten on the next
   * boot by a variable the household thought they had already replaced.
   */
  putBackupPolicy(policy: BackupPolicy, nowMs: number): void {
    assertKeep(policy.keep)
    assertIntervalHours(policy.intervalHours)
    this.#db.update(instanceSettings)
      .set({ backupKeep: policy.keep, backupIntervalHours: policy.intervalHours, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  /**
   * Writes a value into whichever of the two columns is still null and leaves the rest alone,
   * returning what it actually wrote.
   *
   * This is how `HAELAN_BACKUP_KEEP=0` survives becoming a setting. An instance that was already
   * running with backups off would otherwise come back from the migration keeping seven daily
   * copies of a database its operator deliberately never wanted copied, with nothing to tell them
   * until the volume filled. Once a column holds a number - whether from this seed or from the
   * card - it is never seeded again, so the setting wins from then on and an environment variable
   * left behind in a compose file stops mattering.
   */
  seedBackupPolicy(seed: Partial<BackupPolicy>, nowMs: number): Partial<BackupPolicy> {
    const row = this.get()
    // No row means setup has not reached the instance-url step. Nothing to seed onto, and
    // nothing lost: the columns are still null when the wizard does write it, so the next boot
    // seeds them then.
    if (!row) return {}
    const written: Partial<BackupPolicy> = {}
    if (row.backupKeep === null && seed.keep !== undefined) {
      assertKeep(seed.keep)
      written.keep = seed.keep
    }
    if (row.backupIntervalHours === null && seed.intervalHours !== undefined) {
      assertIntervalHours(seed.intervalHours)
      written.intervalHours = seed.intervalHours
    }
    if (written.keep === undefined && written.intervalHours === undefined) return {}
    this.#db.update(instanceSettings).set({
      ...(written.keep === undefined ? {} : { backupKeep: written.keep }),
      ...(written.intervalHours === undefined ? {} : { backupIntervalHours: written.intervalHours }),
      updatedAtMs: nowMs,
    }).where(eq(instanceSettings.id, ROW_ID)).run()
    return written
  }

  /**
   * Whether this instance may ask GitHub about newer releases.
   *
   * Total, like backupPolicy above and for the same reason: there is no settings row until the
   * wizard writes one, and "no row" has to mean the default rather than a crash. The default is
   * the safe direction - an instance that has not been asked does not phone anybody.
   */
  updateCheckEnabled(): boolean {
    return this.get()?.updateCheckEnabled ?? false
  }

  putUpdateCheckEnabled(enabled: boolean, nowMs: number): void {
    this.#db.update(instanceSettings).set({ updateCheckEnabled: enabled, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  putSessionOverlapRatio(ratio: number, nowMs: number): void {
    // At or below zero every pair of sessions overlaps enough; above one no pair ever can.
    // Either would make grouping meaningless rather than merely aggressive.
    if (!(ratio > 0 && ratio <= 1)) {
      throw new ConfigError(`session overlap ratio must be above 0 and at most 1, got ${ratio}`)
    }
    this.#db.update(instanceSettings).set({ sessionOverlapRatio: ratio, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }

  putNightGapMinutes(minutes: number, nowMs: number): void {
    // At or below zero nothing ever joins, so every early wake becomes a nap. Above a day
    // everything on one date joins, so naps stop existing. Neither is a setting, it is a
    // grouping switched off in one of its two directions.
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
      throw new ConfigError(`night gap must be a whole number of minutes from 1 to 1440, got ${minutes}`)
    }
    this.#db.update(instanceSettings).set({ nightGapMinutes: minutes, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }
}

export type SetupStep = 'account' | 'instance-url' | 'google-client' | 'consent' | 'done'

export interface SetupDeps {
  accounts: AccountStore
  settings: SettingsStore
  credentials: CredentialStore
  people: PeopleStore
}

// Derived from the database on every call rather than stored as a step counter, because a
// resumed setup has to land where the data actually is, not where a counter last got to.
export function setupStep(deps: SetupDeps): SetupStep {
  if (deps.accounts.count() === 0) return 'account'
  const settings = deps.settings.get()
  if (!settings) return 'instance-url'
  // The instance flag says only that the wizard once closed without a client, never
  // which member walks which path. A companion mode instance finished with its flag and stamp,
  // so both steps are behind it rather than ahead of it. The completion stamp is checked
  // alongside the flag so a row carrying the flag without it still lands on a step that can
  // finish. Per-person phone choices live on people.companionPath; legacy companion rows predate
  // the column and read as false, which is exactly why the instance flag stays sufficient rather
  // than demanding a flag no legacy row could carry.
  //
  // No client is required for that 'done', and none may be: letting a phone-only instance fall
  // through to the check below would answer 'google-client' instead, which shuts every route
  // outside the wizard (setupGate.ts) and stops the phone syncing with no way back to done. This
  // short-circuit closes no door of its own - the gate keeps /api/setup/google-client open on a
  // completed companion instance while nobody has connected Google yet, so a client can still be
  // pasted afterwards.
  if (settings.companionMode && settings.setupCompletedAtMs !== null) return 'done'
  // Unreadable counts as not configured, and is asked first so this function stays total -
  // getClient throws on a secret this key cannot open, and setupStep runs in a preHandler on
  // every request. A client sealed with a key this instance no longer has is a client nobody can
  // use to refresh a token or start a consent, which is what 'google-client' already means;
  // sending it anywhere else would be inventing a step for a state the wizard already knows how
  // to end. That is the whole of the restore-without-instance.key story: the operator re-enters
  // the client from their Google console, then each person consents once.
  if (deps.credentials.isClientUnreadable() || !deps.credentials.getClient()) return 'google-client'
  if (settings.setupCompletedAtMs === null) return 'consent'
  // Done needs at least one chosen path, not just a stamp. A Google choice is a
  // credentials row for some person (revoked counts: its way back is reconsent, not a wizard
  // that reopens); a phone choice is a per-person flag. No rows and no flags means nobody has
  // connected anything yet, so the wizard is still at the connect step rather than finished.
  const hasGoogle = deps.credentials.listTokenPeople().length > 0
  const hasPhone = deps.people.list().some((p) => p.companionPath)
  if (!hasGoogle && !hasPhone) return 'consent'
  return 'done'
}
