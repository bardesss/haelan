import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { loadOrCreateKey } from '../src/crypto/key.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { CredentialStore } from '../src/store/credentials.ts'
import { PeopleStore } from '../src/store/people.ts'
import {
  SettingsStore, setupStep, DEFAULT_BACKUP_KEEP, DEFAULT_BACKUP_INTERVAL_HOURS,
} from '../src/store/settings.ts'
import { DEFAULT_USER_HORIZON_DAYS } from '../src/api/catalogue.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from '../src/derive/sleep.ts'
import { ConfigError } from '../src/errors.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let fixture: TestDatabase
let accounts: AccountStore
let credentials: CredentialStore
let settings: SettingsStore
let people: PeopleStore

beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
  accounts = new AccountStore(fixture.db)
  credentials = new CredentialStore(fixture.db, loadOrCreateKey(fixture.dir, {}))
  settings = new SettingsStore(fixture.db)
  people = new PeopleStore(fixture.db)
})
afterEach(() => fixture.cleanup())

const addAccount = () => accounts.create({
  id: 'a1', personId: 'p1', username: 'robin', password: 'a good long password', isAdmin: true, nowMs: 0,
})

describe('setupStep', () => {
  it('starts at the account step on an empty instance', () => {
    expect(setupStep({ accounts, settings, credentials, people })).toBe('account')
  })

  it('asks for the instance URL once an account exists', async () => {
    await addAccount()
    expect(setupStep({ accounts, settings, credentials, people })).toBe('instance-url')
  })

  it('asks for the Google client once the URL is known', async () => {
    await addAccount()
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(setupStep({ accounts, settings, credentials, people })).toBe('google-client')
  })

  it('treats a refresh token without the completion mark as an interrupted consent', async () => {
    await addAccount()
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    credentials.putClient({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', nowMs: 1 })
    credentials.putRefreshToken({ personId: 'p1', refreshToken: 'r', scopes: ['a'], nowMs: 1 })
    expect(setupStep({ accounts, settings, credentials, people })).toBe('consent')
    settings.markSetupComplete(2)
    expect(setupStep({ accounts, settings, credentials, people })).toBe('done')
  })

  // A backup restored without instance.key, at the point it is decided. The client secret is
  // sealed with the same key the refresh tokens are, so the household client goes unreadable
  // too - and this function runs in a preHandler on every request, so a throw here used to take
  // the whole app down rather than name a state. A second store over the same database with a
  // different key builds it, so the ciphertext is real and so is the failure to open it.
  it('sends a finished instance back to the Google client step when the key cannot read it', async () => {
    await addAccount()
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    credentials.putClient({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', nowMs: 1 })
    credentials.putRefreshToken({ personId: 'p1', refreshToken: 'r', scopes: ['a'], nowMs: 1 })
    settings.markSetupComplete(2)
    expect(setupStep({ accounts, settings, credentials, people })).toBe('done')

    const restored = new CredentialStore(fixture.db, Buffer.alloc(32, 7))
    expect(setupStep({ accounts, settings, credentials: restored, people })).toBe('google-client')
  })

  it('keeps the settings row single, so a second put updates rather than duplicates', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    settings.put({ baseUrl: 'https://box.tail1234.ts.net', consentPath: 'tailscale', nowMs: 2 })
    expect(settings.get()?.baseUrl).toBe('https://box.tail1234.ts.net')
    expect(fixture.db.$client.prepare('select count(*) as n from instance_settings').get()).toEqual({ n: 1 })
  })

  it('does not lose the sync interval when only the URL is updated', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', syncIntervalMinutes: 15, nowMs: 1 })
    settings.put({ baseUrl: 'http://localhost:9090', consentPath: 'localhost', nowMs: 2 })
    expect(settings.get()?.syncIntervalMinutes).toBe(15)
  })
})

describe('the backfill horizon setting', () => {
  it('defaults to two years for an instance that never chose', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(settings.get()?.backfillHorizonDays).toBe(DEFAULT_USER_HORIZON_DAYS)
  })

  it('keeps a chosen horizon when a later put states only the URL', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    settings.putBackfillHorizon(1825, 2)
    settings.put({ baseUrl: 'http://host:4235', consentPath: 'localhost', nowMs: 3 })
    expect(settings.get()?.backfillHorizonDays).toBe(1825)
  })

  it('round-trips each offered choice', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    for (const days of [365, 730, 1825]) {
      settings.putBackfillHorizon(days, 2)
      expect(settings.get()?.backfillHorizonDays).toBe(days)
    }
  })
})

describe('the session overlap ratio setting', () => {
  it('defaults the session overlap ratio to a half, which is what section 9 names', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(settings.get()?.sessionOverlapRatio).toBe(DEFAULT_OVERLAP_RATIO)
  })

  it('round trips a changed overlap ratio without touching anything else', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    settings.putSessionOverlapRatio(0.7, 2)
    expect(settings.get()?.sessionOverlapRatio).toBe(0.7)
    expect(settings.get()?.baseUrl).toBe('http://localhost:4235')
  })

  it('refuses a ratio outside the range where it means anything', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    // At or below zero every pair of sessions touches; above one no pair ever can.
    expect(() => settings.putSessionOverlapRatio(0, 2)).toThrow(ConfigError)
    expect(() => settings.putSessionOverlapRatio(1.5, 2)).toThrow(ConfigError)
  })
  it('accepts a ratio of exactly one, which the comparison deliberately allows', () => {
    // The bound is `ratio <= 1`, so one means "only sessions that overlap completely are one
    // event". That is a coherent setting, and the boundary is worth pinning because a stricter
    // comparison would silently reject it.
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(() => settings.putSessionOverlapRatio(1, 2)).not.toThrow()
    expect(settings.get()?.sessionOverlapRatio).toBe(1)
  })

})

describe('the night gap setting', () => {
  it('defaults the night gap to two hours', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(settings.get()?.nightGapMinutes).toBe(DEFAULT_NIGHT_GAP_MINUTES)
  })

  it('round trips a changed night gap without touching anything else', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    settings.putNightGapMinutes(45, 2)
    expect(settings.get()?.nightGapMinutes).toBe(45)
    expect(settings.get()?.baseUrl).toBe('http://localhost:4235')
  })

  it('refuses a night gap outside the range where it means anything', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    // At or below zero no two pieces ever join, so every early wake becomes a nap. Above a day
    // every sleep on the same date joins, including an afternoon one, so naps stop existing.
    expect(() => settings.putNightGapMinutes(0, 2)).toThrow(ConfigError)
    expect(() => settings.putNightGapMinutes(-1, 2)).toThrow(ConfigError)
    expect(() => settings.putNightGapMinutes(1441, 2)).toThrow(ConfigError)
  })

  it('accepts a gap of exactly one day, which the comparison deliberately allows', () => {
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(() => settings.putNightGapMinutes(1440, 2)).not.toThrow()
  })
})

// The two numbers that used to be HAELAN_BACKUP_KEEP and HAELAN_BACKUP_INTERVAL_HOURS. Both
// columns are nullable with no default, which is the whole mechanism behind the one-time seed
// below: null is "nobody has chosen yet", and it can only be read that way if nothing quietly
// writes a number into it first.
describe('the backup policy', () => {
  const withRow = () => settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })

  it('answers the defaults on an instance with no settings row at all', () => {
    // The maintenance tick starts before the wizard is finished, so "no row" has to be a policy
    // rather than a crash or a schedule that silently never runs.
    expect(settings.get()).toBeNull()
    expect(settings.backupPolicy()).toEqual({
      keep: DEFAULT_BACKUP_KEEP, intervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
    })
  })

  it('leaves both columns null on a fresh row, and still answers the defaults', () => {
    withRow()
    expect(settings.get()).toMatchObject({ backupKeep: null, backupIntervalHours: null })
    expect(settings.backupPolicy()).toEqual({
      keep: DEFAULT_BACKUP_KEEP, intervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
    })
  })

  it('round trips a chosen policy without touching anything else', () => {
    withRow()
    settings.putBackupPolicy({ keep: 3, intervalHours: 12 }, 2)
    expect(settings.backupPolicy()).toEqual({ keep: 3, intervalHours: 12 })
    expect(settings.get()?.baseUrl).toBe('http://localhost:4235')
  })

  it('keeps zero, which is how a household turns backups off', () => {
    // Not a floor violation and not a value to round up: backupDecision reads zero as "do not
    // take backups" everywhere, so the store has to be able to hold it.
    withRow()
    settings.putBackupPolicy({ keep: 0, intervalHours: 24 }, 2)
    expect(settings.backupPolicy().keep).toBe(0)
  })

  it('refuses numbers outside the range where either means anything', () => {
    withRow()
    expect(() => settings.putBackupPolicy({ keep: -1, intervalHours: 24 }, 2)).toThrow(ConfigError)
    expect(() => settings.putBackupPolicy({ keep: 1.5, intervalHours: 24 }, 2)).toThrow(ConfigError)
    expect(() => settings.putBackupPolicy({ keep: 366, intervalHours: 24 }, 2)).toThrow(ConfigError)
    // Zero hours would make every tick due forever; the count has a floor of zero and this does not.
    expect(() => settings.putBackupPolicy({ keep: 7, intervalHours: 0 }, 2)).toThrow(ConfigError)
    expect(() => settings.putBackupPolicy({ keep: 7, intervalHours: 8761 }, 2)).toThrow(ConfigError)
  })
})

describe('seeding the backup policy from the variables it replaced', () => {
  const withRow = () => settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })

  it('writes a value into a column nobody has chosen yet', () => {
    withRow()
    expect(settings.seedBackupPolicy({ keep: 0, intervalHours: 6 }, 2)).toEqual({ keep: 0, intervalHours: 6 })
    expect(settings.backupPolicy()).toEqual({ keep: 0, intervalHours: 6 })
  })

  it('never writes again once the column holds a number', () => {
    // The whole contract: an instance that had HAELAN_BACKUP_KEEP=0 keeps its zero through the
    // migration, and the household then raising it on the Maintenance card is not undone on the
    // next boot by the variable still sitting in their compose file.
    withRow()
    settings.seedBackupPolicy({ keep: 0, intervalHours: 6 }, 2)
    expect(settings.seedBackupPolicy({ keep: 0, intervalHours: 6 }, 3)).toEqual({})
    settings.putBackupPolicy({ keep: 5, intervalHours: 24 }, 4)
    expect(settings.seedBackupPolicy({ keep: 0, intervalHours: 6 }, 5)).toEqual({})
    expect(settings.backupPolicy()).toEqual({ keep: 5, intervalHours: 24 })
  })

  it('seeds only the half it was given, and leaves the other null for the default to answer', () => {
    withRow()
    expect(settings.seedBackupPolicy({ keep: 2 }, 2)).toEqual({ keep: 2 })
    expect(settings.get()?.backupIntervalHours).toBeNull()
    expect(settings.backupPolicy()).toEqual({ keep: 2, intervalHours: DEFAULT_BACKUP_INTERVAL_HOURS })
  })

  it('does nothing at all before the wizard has written a row', () => {
    expect(settings.seedBackupPolicy({ keep: 0 }, 2)).toEqual({})
    expect(settings.get()).toBeNull()
  })

  it('refuses a value the card would refuse, rather than seeding a number nothing else accepts', () => {
    withRow()
    expect(() => settings.seedBackupPolicy({ keep: -3 }, 2)).toThrow(ConfigError)
    expect(settings.get()?.backupKeep).toBeNull()
  })
})
