import { describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'
import type {
  IntradayPoint, Night, NightSegment, WorkoutSession, TrendPoint, Thinned,
} from '../src/index.ts'

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
    expect(core.schema.sourcePriority).toBeDefined()
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
    expect(typeof core.MERGED_SOURCE).toBe('string')
  })

  it('exports the local day and coverage functions', () => {
    expect(typeof core.localDateOf).toBe('function')
    expect(typeof core.localHourOf).toBe('function')
    expect(typeof core.shiftLocalDate).toBe('function')
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

  describe('M2b: choosing between sources, and the corrections applied while we do', () => {
    it('exports the priority rule and the merge', () => {
      expect(typeof core.priorityFrom).toBe('function')
      expect(typeof core.fallbackOrder).toBe('function')
      expect(typeof core.DEFAULT_LIST).toBe('string')
      expect(typeof core.UNRANKED_BASE).toBe('number')
      expect(typeof core.mergeDay).toBe('function')
    })

    it('exports the target key builders and their parsers', () => {
      expect(typeof core.sampleTarget).toBe('function')
      expect(typeof core.sessionTarget).toBe('function')
      expect(typeof core.dayMetricTarget).toBe('function')
      expect(typeof core.parseSampleTarget).toBe('function')
      expect(typeof core.parseSessionTarget).toBe('function')
      expect(typeof core.parseDayMetricTarget).toBe('function')
    })

    it('exports the session grouping M2c derives sleep from', () => {
      expect(typeof core.groupSessions).toBe('function')
      expect(typeof core.DEFAULT_OVERLAP_RATIO).toBe('number')
    })

    it('does not export the derivation internals, which are not a consumer concern', async () => {
      // Each of these has exactly one caller, runDerive, inside its own transaction. The same
      // line is drawn above for the mappers' internals, and an export nothing outside the
      // package uses is a promise about a signature nobody meant to make.
      const api = await import('../src/index.ts') as Record<string, unknown>
      expect(api['applyToSamples']).toBeUndefined()
      expect(api['applyToDay']).toBeUndefined()
      expect(api['applyToSessions']).toBeUndefined()
      expect(api['excludedMetrics']).toBeUndefined()
      expect(api['encodeMix']).toBeUndefined()
    })

    it('exports the two stores M3 writes priority and overrides through', () => {
      expect(typeof core.SourcePriorityStore).toBe('function')
      expect(typeof core.OverrideStore).toBe('function')
    })

    it('is callable, not merely present: a target key round trips and a rank comes back', () => {
      const key = core.sampleTarget({ source: 'watch', metric: 'steps', utcMs: 1000 })
      expect(core.parseSampleTarget(key)).toEqual({ source: 'watch', metric: 'steps', utcMs: 1000 })

      const priority = core.priorityFrom({
        lists: new Map([['steps', ['phone']]]),
        sources: [{ id: 'watch', kind: 'device' }, { id: 'phone', kind: 'app' }],
      })
      expect(priority.rank('steps', 'phone')).toBe(0)
      expect(priority.rank('steps', 'watch')).toBeGreaterThanOrEqual(core.UNRANKED_BASE)
    })
  })

  describe('M2c: sleep, from sessions and their stages to a day\'s figures', () => {
    it('exports night assembly and the day derivation', () => {
      expect(typeof core.assembleNights).toBe('function')
      expect(typeof core.deriveSleepDay).toBe('function')
      expect(typeof core.DEFAULT_NIGHT_GAP_MINUTES).toBe('number')
      expect(Array.isArray(core.ASLEEP_STAGES)).toBe(true)
      expect(typeof core.AWAKE_STAGE).toBe('string')
    })

    it('exports the merge across sources and the sleep metric family', () => {
      expect(typeof core.mergeSleepDay).toBe('function')
      expect(Array.isArray(core.SLEEP_METRICS)).toBe(true)
      expect(core.SLEEP_METRICS).toHaveLength(11)
    })
  })

  describe('M2d: the person bound query layer, and the statistics behind it', () => {
    it('exports the query class and its point type', () => {
      expect(typeof core.PersonQuery).toBe('function')
    })

    it('exports the baseline function and its constants', () => {
      expect(typeof core.baselineOf).toBe('function')
      expect(typeof core.baselineWindow).toBe('function')
      expect(typeof core.zScoreOf).toBe('function')
      expect(typeof core.BASELINE_WINDOW_DAYS).toBe('number')
      expect(typeof core.BASELINE_MIN_DAYS).toBe('number')
    })

    it('exports the insight function and its constants', () => {
      expect(typeof core.comparePeriods).toBe('function')
      expect(typeof core.INSIGHT_MIN_DAY_FRACTION).toBe('number')
      expect(typeof core.INSIGHT_MIN_COVERAGE).toBe('number')
    })
  })

  describe('M3b1: the trend, and the four bound readers on PersonQuery', () => {
    // Each of these is a type with nothing to call at runtime, so the assertion behind the export
    // is that a value PersonQuery actually returns is assignable to it: if the barrel dropped one
    // or the shape drifted from what the reader produces, this fails to typecheck rather than
    // silently passing with no assertion behind it at all.
    it('is callable, not merely present: every new reader returns the shape its export promises', () => {
      const test = core.createTestDatabase()
      try {
        core.seedPerson(test.db, 'p1')
        test.db.insert(core.schema.sources).values({
          id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
          kind: 'device', createdAtMs: 0,
        }).run()
        test.db.insert(core.schema.samples).values({
          personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
          utcMs: Date.UTC(2026, 7, 1, 9, 0), tzOffsetMinutes: 0, agg: 'mean', value: 60,
          n: 1, rawPayloadId: null,
        }).run()
        test.db.insert(core.schema.sessions).values({
          id: 'night', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'night',
          startMs: 0, startOffsetMinutes: 0, endMs: 1000, endOffsetMinutes: 0,
          localDate: '2026-08-01', attrs: '{}', rawPayloadId: null,
        }).run()

        const query = new core.PersonQuery(test.db, 'p1')

        const intraday: { points: IntradayPoint[], reduction: Thinned<IntradayPoint>['reduction'] } =
          query.intraday({ metric: 'heart_rate', localDate: '2026-08-01' })
        expect(intraday.points).toHaveLength(1)

        const nights: Night[] = query.sleepNights({ from: '2026-08-01', to: '2026-08-01' })
        expect(nights).toHaveLength(1)
        const segments: NightSegment[] = nights[0]!.segments
        expect(segments).toEqual([])

        const sessions: WorkoutSession[] = query.sessions({ kind: 'sleep', from: '2026-08-01', to: '2026-08-01' })
        expect(sessions.map((s) => s.id)).toEqual(['night'])

        const trend: TrendPoint[] = query.trend({
          metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01',
        })
        expect(trend).toEqual([])
      } finally { test.cleanup() }
    })

    // readIntraday, readSleepNights and readSessions all take a plain person id, not a bound
    // query. What holds the person-isolation guarantee, that a caller who forgets a WHERE clause
    // must not be able to reach another member's data, is that none of the three is reachable
    // except through PersonQuery, which binds the id once at construction and never again. Adding
    // one of them to the barrel would hand every later caller, including a later milestone's SQL
    // surface, a way to name a person id straight from the outside, quietly widening a guarantee
    // person-query-isolation.test.ts otherwise pins shut.
    it('does not export the bound readers themselves, only the shapes they return', async () => {
      const api = await import('../src/index.ts') as Record<string, unknown>
      expect(api['readIntraday']).toBeUndefined()
      expect(api['readSleepNights']).toBeUndefined()
      expect(api['readSessions']).toBeUndefined()
    })
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
