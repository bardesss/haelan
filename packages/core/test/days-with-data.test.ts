import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

function insertDaily(o: { metric: string, agg?: string, localDate: string, value: number }) {
  test.db.insert(daily).values({
    personId: 'p1', localDate: o.localDate, metric: o.metric, agg: o.agg ?? 'sum', source: 'merged',
    value: o.value, coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: 123,
  }).run()
}

let sleepSeq = 0
function insertSleepNight(localDate: string) {
  sleepSeq += 1
  const id = `sleep-${sleepSeq}`
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
    startMs: Date.parse(`${localDate}T22:00:00Z`), startOffsetMinutes: 0,
    endMs: Date.parse(`${localDate}T22:00:00Z`) + 8 * 3_600_000, endOffsetMinutes: 0,
    localDate, attrs: JSON.stringify({}), rawPayloadId: null,
  }).run()
}

function seedFixture() {
  insertDaily({ metric: 'steps', localDate: '2026-09-01', value: 1000 })
  insertDaily({ metric: 'steps', localDate: '2026-09-03', value: 2000 })
  insertDaily({ metric: 'resting_heart_rate', agg: 'last', localDate: '2026-09-05', value: 55 })
  insertSleepNight('2026-09-07')
  insertDaily({ metric: 'weight', localDate: '2026-09-09', value: 80 })
}

describe('daysWithData', () => {
  it('lists the sorted local dates in range that have a glance metric row or a sleep night', () => {
    seedFixture()
    const query = new PersonQuery(test.db, 'p1')
    expect(query.daysWithData({ from: '2026-09-01', to: '2026-09-10' }))
      .toEqual(['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07'])
  })

  it('excludes a metric that is not one of the glance day metrics', () => {
    insertDaily({ metric: 'weight', localDate: '2026-09-09', value: 80 })
    const query = new PersonQuery(test.db, 'p1')
    expect(query.daysWithData({ from: '2026-09-01', to: '2026-09-10' })).toEqual([])
  })

  it('finds a sleep night even with no daily rows on that date', () => {
    insertSleepNight('2026-09-07')
    const query = new PersonQuery(test.db, 'p1')
    expect(query.daysWithData({ from: '2026-09-01', to: '2026-09-10' })).toEqual(['2026-09-07'])
  })

  it('rejects a malformed date', () => {
    const query = new PersonQuery(test.db, 'p1')
    expect(() => query.daysWithData({ from: 'not-a-date', to: '2026-09-10' })).toThrow()
  })
})

describe('nearestDayWithData', () => {
  beforeEach(() => seedFixture())

  it('finds the nearest day with data strictly before the given date', () => {
    const query = new PersonQuery(test.db, 'p1')
    expect(query.nearestDayWithData({ on: '2026-09-05', direction: 'before' })).toBe('2026-09-03')
  })

  it('finds the nearest day with data strictly after the given date', () => {
    const query = new PersonQuery(test.db, 'p1')
    expect(query.nearestDayWithData({ on: '2026-09-05', direction: 'after' })).toBe('2026-09-07')
  })

  it('is null when nothing follows', () => {
    const query = new PersonQuery(test.db, 'p1')
    expect(query.nearestDayWithData({ on: '2026-09-07', direction: 'after' })).toBeNull()
  })

  it('is null when nothing precedes', () => {
    const query = new PersonQuery(test.db, 'p1')
    expect(query.nearestDayWithData({ on: '2026-09-01', direction: 'before' })).toBeNull()
  })

  it('never crosses the until bound', () => {
    const query = new PersonQuery(test.db, 'p1')
    expect(query.nearestDayWithData({ on: '2026-09-03', direction: 'after', until: '2026-09-04' })).toBeNull()
  })
})
