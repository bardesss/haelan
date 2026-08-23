import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { daily } from '../src/db/schema/index.ts'

let test: TestDatabase
let query: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  query = new PersonQuery(test.db, 'p1')
})
afterEach(() => test.cleanup())

const insertDaily = (o: {
  localDate: string, value: number | null, metric?: string, agg?: string,
  source?: string, coverage?: number | null, personId?: string,
}) => {
  test.db.insert(daily).values({
    personId: o.personId ?? 'p1',
    localDate: o.localDate,
    metric: o.metric ?? 'steps',
    agg: o.agg ?? 'sum',
    source: o.source ?? 'merged',
    value: o.value,
    coverage: o.coverage === undefined ? 0.9 : o.coverage,
    sourceMix: null,
    derivationVersion: 3,
  }).run()
}

describe('PersonQuery.series', () => {
  it('returns the days in the range, oldest first', () => {
    insertDaily({ localDate: '2026-08-03', value: 300 })
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-02', value: 200 })

    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-03' })
    expect(points.map((p) => p.localDate)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(points.map((p) => p.value)).toEqual([100, 200, 300])
  })

  it('includes both ends of the range', () => {
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-05', value: 500 })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points).toHaveLength(2)
  })

  it('excludes days outside the range', () => {
    insertDaily({ localDate: '2026-07-31', value: 1 })
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-06', value: 1 })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points.map((p) => p.value)).toEqual([100])
  })

  it('reads the merged row by default, because that is the answer to what happened', () => {
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'watch' })
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([900])
  })

  it('reads one source when asked, so provenance stays reachable', () => {
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'watch' })
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01', source: 'watch' })
    expect(points.map((p) => p.value)).toEqual([400])
  })

  it('separates aggregates of the same metric', () => {
    insertDaily({ localDate: '2026-08-01', value: 52, metric: 'heart_rate', agg: 'min' })
    insertDaily({ localDate: '2026-08-01', value: 88, metric: 'heart_rate', agg: 'max' })
    const points = query.series({ metric: 'heart_rate', agg: 'max', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([88])
  })

  it('carries coverage through, including a null one', () => {
    insertDaily({ localDate: '2026-08-01', value: 480, metric: 'sleep_asleep_minutes', coverage: null })
    const points = query.series({ metric: 'sleep_asleep_minutes', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points[0]?.coverage).toBeNull()
  })

  it('drops a row with no value, because that is not a measurement', () => {
    // Nothing writes one today: every producer skips a null before it builds a row. The guard
    // is here so a future producer that does cannot silently put a hole in a mean.
    insertDaily({ localDate: '2026-08-01', value: null })
    insertDaily({ localDate: '2026-08-02', value: 200 })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-02' })
    expect(points.map((p) => p.value)).toEqual([200])
  })

  it('returns an empty series rather than throwing when there is nothing', () => {
    expect(query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })).toEqual([])
  })
})
