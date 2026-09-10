import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { ExcludedDataTypeStore } from '../src/store/excludedDataTypes.ts'
import { CredentialStore } from '../src/store/credentials.ts'
import { TokenProvider } from '../src/api/tokens.ts'
import { HealthClient } from '../src/api/client.ts'
import { DATA_TYPES, dataTypeById } from '../src/api/catalogue.ts'
import { runJob } from '../src/sync/runJob.ts'
import { runBackfill } from '../src/sync/runBackfill.ts'
import { runSync } from '../src/sync/runSync.ts'
import { syncState as syncStateTable } from '../src/db/schema/index.ts'
import type { JobDeps } from '../src/sync/runJob.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const AMS = 'Europe/Amsterdam'
const KEY = Buffer.alloc(32, 9)

// The state a restored backup actually produces: a credentials row that exists, was once
// readable, and now is sealed under a key this process does not hold. The commit that named
// CredentialsUnreadableError widened five production sites to treat it as "stop this person's
// walk, quietly and by name" instead of "record a per-window sync failure" - runJob, runBackfill,
// runSync's rollup catch, and two sites in apps/server/src/sync/runner.ts (its own test covers
// those, see sync-runner.test.ts). None of the five had a test naming the state; each of them is
// deleteable today with the whole suite staying green. These do the opposite: build the state the
// way maintenance-routes.test.ts's "connected: false, credentialsUnreadable: true" test does -
// two CredentialStores over the same database, the second sealing the row under a key the first
// never held - and drive a real sync down through it, asserting the branch's whole claim: the
// person is skipped, and nothing lands in sync_state for them.
describe('a stored refresh token instance.key cannot decrypt, mid sync', () => {
  let ctx: TestDatabase

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1', { timezone: AMS })
    new CredentialStore(ctx.db, KEY).putRefreshToken({
      personId: 'p1', refreshToken: 'rt', scopes: [], nowMs: 0,
    })
    // Overwritten under a key nothing built below holds, so getRefreshToken's own decrypt fails
    // for real rather than a stub raising the class directly - which is what proves
    // credentials.ts's try/catch, not just its callers, is on the path under test.
    new CredentialStore(ctx.db, randomBytes(32)).putRefreshToken({
      personId: 'p1', refreshToken: 'sealed-under-a-key-this-process-does-not-have', scopes: [], nowMs: 0,
    })
  })
  afterEach(() => { ctx.cleanup(); vi.restoreAllMocks() })

  // A real TokenProvider over the real (wrong-keyed) CredentialStore, wired into a real
  // HealthClient - not a stub whose accessTokenFor throws the error class by hand. The token
  // endpoint fetch and the data fetch are both stubs that would fail the test if ever reached:
  // a credential that cannot be decrypted must fail before either one is called.
  const deps = (): JobDeps => {
    const archive = new RawArchive(ctx.db)
    const credentials = new CredentialStore(ctx.db, KEY)
    const tokens = new TokenProvider(credentials, {
      fetch: vi.fn(async () => { throw new Error('token endpoint reached; credential should have failed first') }),
      now: () => 1,
    })
    const client = new HealthClient(tokens, archive, {
      fetch: vi.fn(async () => { throw new Error('data endpoint reached; credential should have failed first') }),
      now: () => 1,
      sleep: async () => {},
      random: () => 0,
    })
    return {
      db: ctx.db,
      archive,
      sources: new SourceRegistry(ctx.db),
      syncState: new SyncStateStore(ctx.db),
      client,
      now: () => Date.parse('2026-08-19T12:00:00Z'),
    }
  }

  it('runJob skips the person by name instead of recording a per type sync failure', async () => {
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: deps(),
    })
    expect(result.skipped).toBe('credentials_unreadable')
    // The branch this guards (runJob.ts's catch, and credentials.ts's own catch underneath it):
    // deleting either falls through to recordFailure, which would write a row here.
    expect(ctx.db.select().from(syncStateTable).all()).toEqual([])
  })

  it('runBackfill stops the walk by name instead of recording a per type sync failure', async () => {
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('oxygen-saturation')!,
      nowMs: Date.parse('2026-08-19T12:00:00Z'), horizonDays: 30, deps: deps(),
    })
    expect(result.stoppedBecause).toBe('credentials_unreadable')
    expect(result.complete).toBe(false)
    expect(ctx.db.select().from(syncStateTable).all()).toEqual([])
  })

  it('runSync skips a rollup-only type by name instead of recording a per type sync failure', async () => {
    // total-calories answers only rollUp/dailyRollUp - runSync.ts's rollup branch (126-129) is
    // the only one of the five sites that a list-shaped job never reaches, since runRollupJob
    // throws rather than returning a result runJob-style. Every other type is excluded so the
    // one job dueJobs hands back is this one, rather than paying for the whole catalogue to
    // prove a single catch clause.
    new ExcludedDataTypeStore(ctx.db).setFor({
      personId: 'p1', nowMs: 0,
      dataTypeIds: DATA_TYPES.filter((t) => t.id !== 'total-calories').map((t) => t.id),
    })

    const report = await runSync({
      personIds: ['p1'], trailingDays: 7, userHorizonDays: 365, deps: deps(),
    })

    expect(report.jobs).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.failed).toBe(0)
    expect(ctx.db.select().from(syncStateTable).all()).toEqual([])
  })
})
