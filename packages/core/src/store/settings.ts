import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { instanceSettings } from '../db/schema/index.ts'
import type { ConsentPath } from '../db/schema/accounts.ts'
import type { AccountStore } from './accounts.ts'
import type { CredentialStore } from './credentials.ts'

const ROW_ID = 'default'

export interface InstanceSettingsRow {
  baseUrl: string
  consentPath: ConsentPath
  syncIntervalMinutes: number
  backfillHorizonDays: number
  setupCompletedAtMs: number | null
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

  putBackfillHorizon(days: number, nowMs: number): void {
    this.#db.update(instanceSettings).set({ backfillHorizonDays: days, updatedAtMs: nowMs })
      .where(eq(instanceSettings.id, ROW_ID)).run()
  }
}

export type SetupStep = 'account' | 'instance-url' | 'google-client' | 'consent' | 'done'

export interface SetupDeps {
  accounts: AccountStore
  settings: SettingsStore
  credentials: CredentialStore
}

// Derived from the database on every call rather than stored as a step counter, because a
// resumed setup has to land where the data actually is, not where a counter last got to.
export function setupStep(deps: SetupDeps): SetupStep {
  if (deps.accounts.count() === 0) return 'account'
  const settings = deps.settings.get()
  if (!settings) return 'instance-url'
  if (!deps.credentials.getClient()) return 'google-client'
  if (settings.setupCompletedAtMs === null) return 'consent'
  return 'done'
}
