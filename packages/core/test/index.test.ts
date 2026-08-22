import { describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'

// Every other test imports by relative path, so this barrel is the package's only integration
// point with server, mcp, cli and web. Nothing else fails if a line is deleted from it.
describe('package barrel', () => {
  it('exports the database lifecycle', () => {
    expect(typeof core.openDatabase).toBe('function')
    expect(typeof core.closeDatabase).toBe('function')
    expect(typeof core.tableExists).toBe('function')
    expect(typeof core.DATABASE_FILENAME).toBe('string')
    expect(typeof core.migrateToLatest).toBe('function')
  })

  it('exports the schema namespace', () => {
    expect(typeof core.schema).toBe('object')
    expect(core.schema.people).toBeDefined()
    expect(core.schema.sources).toBeDefined()
    expect(core.schema.oauthClient).toBeDefined()
    expect(core.schema.credentials).toBeDefined()
    expect(core.schema.notes).toBeDefined()
    expect(core.schema.events).toBeDefined()
    expect(core.schema.overrides).toBeDefined()
    expect(core.schema.rawPayloads).toBeDefined()
    expect(core.schema.samples).toBeDefined()
    expect(core.schema.sessions).toBeDefined()
    expect(core.schema.sessionSegments).toBeDefined()
    expect(core.schema.daily).toBeDefined()
    expect(core.schema.syncState).toBeDefined()
  })

  it('exports the crypto primitives', () => {
    expect(typeof core.loadOrCreateKey).toBe('function')
    expect(typeof core.KEY_FILENAME).toBe('string')
    expect(typeof core.KEY_ENV_VAR).toBe('string')
    expect(typeof core.seal).toBe('function')
    expect(typeof core.unseal).toBe('function')
  })

  it('exports the store classes', () => {
    expect(typeof core.CredentialStore).toBe('function')
    expect(typeof core.RawArchive).toBe('function')
  })

  it('exports the test fixtures', () => {
    expect(typeof core.createTestDatabase).toBe('function')
    expect(typeof core.seedPerson).toBe('function')
  })

  it('exports the API catalogue', () => {
    expect(Array.isArray(core.DATA_TYPES)).toBe(true)
    expect(typeof core.dataTypeById).toBe('function')
    expect(Array.isArray(core.FILTER_MEMBERS)).toBe(true)
  })

  it('exports the token provider, client and mappers', () => {
    expect(typeof core.TokenProvider).toBe('function')
    expect(typeof core.RevokedError).toBe('function')
    expect(typeof core.HealthClient).toBe('function')
    expect(typeof core.mapSamples).toBe('function')
    expect(typeof core.mapWindowSamples).toBe('function')
    expect(typeof core.mapSessions).toBe('function')
  })

  it('does not export the mappers internals, which are not a consumer concern', async () => {
    const api = await import('../src/index.ts') as Record<string, unknown>
    expect(api['parseInstant']).toBeUndefined()
    expect(api['downsampleToMinute']).toBeUndefined()
  })

  it('exports the error taxonomy', () => {
    expect(typeof core.HaelanError).toBe('function')
    expect(typeof core.AuthError).toBe('function')
    expect(typeof core.TransientError).toBe('function')
    expect(typeof core.SchemaDriftError).toBe('function')
    expect(typeof core.DataQualityError).toBe('function')
    expect(typeof core.ConfigError).toBe('function')
    expect(typeof core.classifyHttp).toBe('function')
  })

  it('exports the composition root', () => {
    expect(typeof core.openHaelan).toBe('function')
  })

  it('exports the sync engine', () => {
    expect(typeof core.SourceRegistry).toBe('function')
    expect(typeof core.SyncStateStore).toBe('function')
    expect(typeof core.dayWindows).toBe('function')
    expect(typeof core.TokenBucket).toBe('function')
    expect(typeof core.runJob).toBe('function')
    expect(typeof core.runSync).toBe('function')
  })

  it('exports the account, session and settings stores the wizard writes through', () => {
    expect(typeof core.PeopleStore).toBe('function')
    expect(typeof core.AccountStore).toBe('function')
    expect(typeof core.SessionStore).toBe('function')
    expect(typeof core.SettingsStore).toBe('function')
    expect(typeof core.SESSION_TTL_MS).toBe('number')
    expect(typeof core.setupStep).toBe('function')
    expect(Array.isArray(core.CONSENT_PATHS)).toBe(true)
  })

  it('exports the consent round trip', () => {
    expect(typeof core.buildConsentUrl).toBe('function')
    expect(typeof core.exchangeAuthorizationCode).toBe('function')
    expect(typeof core.probeAccess).toBe('function')
    expect(core.SCOPES).toHaveLength(6)
  })

  it('exports the backfill and its horizon controls', () => {
    expect(typeof core.runBackfill).toBe('function')
    expect(typeof core.horizonDaysFor).toBe('function')
    expect(typeof core.INTRADAY_HORIZON_DAYS).toBe('number')
    expect(typeof core.DEFAULT_USER_HORIZON_DAYS).toBe('number')
    expect(Array.isArray(core.USER_HORIZON_CHOICES)).toBe(true)
  })

  it('exports the synthetic payload builders the server stub is built from', () => {
    expect(typeof core.samplePoint).toBe('function')
    expect(typeof core.intervalPoint).toBe('function')
    expect(typeof core.dailyPoint).toBe('function')
    expect(typeof core.sleepPoint).toBe('function')
    expect(typeof core.body).toBe('function')
  })

  it('exports the metric catalogue and the derivation constants', () => {
    expect(typeof core.METRICS).toBe('object')
    expect(Array.isArray(core.DAILY_AGGS)).toBe(true)
    expect(typeof core.metricSpec).toBe('function')
    expect(typeof core.DERIVATION_VERSION).toBe('number')
    expect(typeof core.PROVIDER_SOURCE).toBe('string')
  })

  it('exports the local day and coverage functions', () => {
    expect(typeof core.localDateOf).toBe('function')
    expect(typeof core.localHourOf).toBe('function')
    expect(typeof core.coverageOf).toBe('function')
  })

  it('exports the rollup engine, the drain and the two rollup-only read paths', () => {
    expect(typeof core.rollUpDay).toBe('function')
    expect(typeof core.runDerive).toBe('function')
    expect(typeof core.DeriveQueue).toBe('function')
    expect(typeof core.mapRollups).toBe('function')
    expect(typeof core.runRollupJob).toBe('function')
    expect(typeof core.rollupRangeCapDays).toBe('function')
  })

  it('exports the actions the catalogue supports', () => {
    expect(Array.isArray(core.ACTIONS)).toBe(true)
    expect(typeof core.supports).toBe('function')
  })

  it('is callable, not merely present: setupStep answers on a real empty instance', () => {
    // A barrel test that only checks typeof passes on an export wired to the wrong module.
    const fixture = core.createTestDatabase()
    try {
      const step = core.setupStep({
        accounts: new core.AccountStore(fixture.db),
        settings: new core.SettingsStore(fixture.db),
        credentials: new core.CredentialStore(fixture.db, core.loadOrCreateKey(fixture.dir, {})),
      })
      expect(step).toBe('account')
    } finally { fixture.cleanup() }
  })
})
