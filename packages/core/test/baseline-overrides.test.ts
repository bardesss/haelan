import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { SourcePriorityStore } from '../src/store/sourcePriority.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { runDerive } from '../src/derive/runDerive.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { dayMetricTarget } from '../src/derive/targetKey.ts'
import { sources } from '../src/db/schema/index.ts'
import { insertSample } from '../src/testing/fixtures.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'

/**
 * Spec section 14 names "baselines ignore overridden points" among the property tests. M2d's plan
 * argued it holds by construction, and it does: overrides apply at derivation, an excluded day
 * loses its `daily` row, and a baseline reads only `daily`. Nothing pinned the composition, which
 * means the guarantee lived in an argument rather than in the suite, and a derive path that one
 * day writes a daily row without passing through the override application would break it with
 * every existing test still green.
 *
 * So this exercises the whole chain rather than either half: samples in, derivation, baseline out.
 */

const OFFSET = 120
const LOCAL_DATE = (day: number) => `2026-08-${String(day).padStart(2, '0')}`
// Local hour on the given date, which is two hours earlier in UTC at this offset.
const AT = (day: number, localHour: number) => Date.UTC(2026, 7, day, localHour - 2, 0)
/**
 * Sixteen worn hours a day, not one reading. A baseline drops days whose coverage falls below the
 * insight floor, so a single sample a day would be filtered out before the override ever mattered
 * and the test would pass against an empty baseline.
 */
const WORN_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]

let test: TestDatabase
let queue: DeriveQueue
let priority: SourcePriorityStore
let overrides: OverrideStore
let settings: SettingsStore
let query: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
    kind: 'device', createdAtMs: 0,
  }).run()
  queue = new DeriveQueue(test.db)
  priority = new SourcePriorityStore(test.db, queue)
  overrides = new OverrideStore(test.db, queue)
  settings = new SettingsStore(test.db)
  settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })
  query = new PersonQuery(test.db, 'p1')
})
afterEach(() => test.cleanup())

const DAYS = [1, 2, 3, 4, 5, 6, 7]
const GLITCH_DAY = 4

const seedDays = () => {
  for (const day of DAYS) {
    // One wild day among seven ordinary ones, which is the case an override exists for.
    const value = day === GLITCH_DAY ? 210 : 60
    for (const hour of WORN_HOURS) {
      insertSample(test.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: AT(day, hour),
        tzOffsetMinutes: OFFSET, agg: 'raw', value,
      })
    }
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE(day), nowMs: day })
  }
}

const drain = () => runDerive({ db: test.db, queue, priority, overrides, settings, nowMs: 1 })

// The day after the last seeded one, so the window covers all seven and excludes nothing by date.
const baseline = () => query.baseline({
  metric: 'heart_rate', agg: 'mean', on: shiftLocalDate(LOCAL_DATE(DAYS.at(-1)!), 1), windowDays: 60,
})

describe('baselines and overrides', () => {
  it('drops an overridden day from the baseline, and restores it exactly when the override goes', () => {
    seedDays()
    drain()

    const before = baseline()
    expect(before?.n).toBe(DAYS.length)

    overrides.put({
      personId: 'p1',
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: LOCAL_DATE(GLITCH_DAY), metric: 'heart_rate' }),
      action: 'exclude',
      reason: 'the strap was reporting nonsense',
      nowMs: 100,
    })
    drain()

    const excluded = baseline()
    // The day is gone rather than zeroed: a zero would drag the centre down instead of leaving it
    // to the six readings that were actually taken.
    expect(excluded?.n).toBe(DAYS.length - 1)
    expect(excluded?.center).toBe(60)

    const stored = overrides.listFor('p1')[0]!
    overrides.remove({ personId: 'p1', id: stored.id, nowMs: 200 })
    drain()

    expect(baseline()).toEqual(before)
  })

  it('leaves the baseline alone when the override targets another metric', () => {
    seedDays()
    drain()
    const before = baseline()

    overrides.put({
      personId: 'p1',
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: LOCAL_DATE(GLITCH_DAY), metric: 'steps' }),
      action: 'exclude',
      reason: 'a different metric entirely',
      nowMs: 100,
    })
    drain()

    expect(baseline()).toEqual(before)
  })
})
