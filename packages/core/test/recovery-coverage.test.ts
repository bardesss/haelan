import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, insertSample, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { SourcePriorityStore } from '../src/store/sourcePriority.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { runDerive } from '../src/derive/runDerive.ts'
import { METRICS } from '../src/derive/metrics.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'
import { daily, sources } from '../src/db/schema/index.ts'

// The three the M2 spec's M2c row names. They are sample metrics, so nothing in M2c derives them:
// this file exists to prove that, rather than to leave it an assumption somebody re-litigates.
const RECOVERY = ['resting_heart_rate', 'daily_hrv', 'respiratory_rate']

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const LOCAL_DATE = '2026-08-22'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => test.cleanup())

describe('recovery metrics', () => {
  it('each has a catalogue entry, so a rollup can produce it', () => {
    for (const metric of RECOVERY) {
      expect(METRICS[metric], `no METRICS entry for ${metric}`).toBeDefined()
    }
  })

  it('each is reachable from a data type, so a sync can fetch it', () => {
    const fetchable = new Set(DATA_TYPES.map((t) => t.metric))
    for (const metric of RECOVERY) {
      expect(fetchable.has(metric), `no data type produces ${metric}`).toBe(true)
    }
  })

  it('each produces a daily row from an ordinary sample, with no help from M2c', () => {
    const queue = new DeriveQueue(test.db)
    const settings = new SettingsStore(test.db)
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })

    for (const metric of RECOVERY) {
      insertSample(test.db, {
        personId: 'p1', sourceId: 'watch', metric,
        utcMs: MIDNIGHT_UTC + 9 * 3_600_000, tzOffsetMinutes: OFFSET, value: 55,
      })
    }
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({
      db: test.db, queue,
      priority: new SourcePriorityStore(test.db, queue),
      overrides: new OverrideStore(test.db, queue),
      settings,
      nowMs: 1,
    })

    const written = test.db.select().from(daily).where(eq(daily.personId, 'p1')).all()
    for (const metric of RECOVERY) {
      expect(written.some((r) => r.metric === metric && r.source === 'watch'), `no per source row for ${metric}`).toBe(true)
      expect(written.some((r) => r.metric === metric && r.source === 'merged'), `no merged row for ${metric}`).toBe(true)
    }
  })
})
