import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { loadOrCreateKey } from '../src/crypto/key.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { CredentialStore } from '../src/store/credentials.ts'
import { SettingsStore, setupStep } from '../src/store/settings.ts'
import { DEFAULT_USER_HORIZON_DAYS } from '../src/api/catalogue.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { ConfigError } from '../src/errors.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let fixture: TestDatabase
let accounts: AccountStore
let credentials: CredentialStore
let settings: SettingsStore

beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
  accounts = new AccountStore(fixture.db)
  credentials = new CredentialStore(fixture.db, loadOrCreateKey(fixture.dir, {}))
  settings = new SettingsStore(fixture.db)
})
afterEach(() => fixture.cleanup())

const addAccount = () => accounts.create({
  id: 'a1', personId: 'p1', username: 'bartus', password: 'a good long password', isAdmin: true, nowMs: 0,
})

describe('setupStep', () => {
  it('starts at the account step on an empty instance', () => {
    expect(setupStep({ accounts, settings, credentials })).toBe('account')
  })

  it('asks for the instance URL once an account exists', async () => {
    await addAccount()
    expect(setupStep({ accounts, settings, credentials })).toBe('instance-url')
  })

  it('asks for the Google client once the URL is known', async () => {
    await addAccount()
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    expect(setupStep({ accounts, settings, credentials })).toBe('google-client')
  })

  it('treats a refresh token without the completion mark as an interrupted consent', async () => {
    await addAccount()
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
    credentials.putClient({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', nowMs: 1 })
    credentials.putRefreshToken({ personId: 'p1', refreshToken: 'r', scopes: ['a'], nowMs: 1 })
    expect(setupStep({ accounts, settings, credentials })).toBe('consent')
    settings.markSetupComplete(2)
    expect(setupStep({ accounts, settings, credentials })).toBe('done')
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
