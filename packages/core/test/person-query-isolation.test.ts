import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { daily } from '../src/db/schema/index.ts'

let test: TestDatabase
let alice: PersonQuery
let bart: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  seedPerson(test.db, 'bart')
  alice = new PersonQuery(test.db, 'alice')
  bart = new PersonQuery(test.db, 'bart')

  // The same metric, the same aggregate, the same days, different numbers. Anything that
  // crossed between them would be visible rather than plausible.
  for (let day = 1; day <= 28; day += 1) {
    const localDate = `2026-08-${String(day).padStart(2, '0')}`
    for (const [personId, value] of [['alice', 1000], ['bart', 9000]] as const) {
      test.db.insert(daily).values({
        personId, localDate, metric: 'steps', agg: 'sum', source: 'merged',
        value, coverage: 0.9, sourceMix: null, derivationVersion: 4,
      }).run()
    }
  }
})
afterEach(() => test.cleanup())

describe('PersonQuery isolation', () => {
  it('reads only its own person series', () => {
    const points = alice.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-28' })
    expect(points).toHaveLength(28)
    expect(points.every((p) => p.value === 1000)).toBe(true)
  })

  it('builds a baseline only from its own person', () => {
    // Both people have 28 days. A query that leaked would find 56 and a centre of 5000.
    const baseline = alice.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-29' })
    expect(baseline?.n).toBe(28)
    expect(baseline?.center).toBeCloseTo(1000, 10)
  })

  it('compares only its own person periods', () => {
    const insight = bart.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-15', to: '2026-08-21' })
    expect(insight.current).toBeCloseTo(9000, 10)
    expect(insight.previous).toBeCloseTo(9000, 10)
    expect(insight.currentDays).toBe(7)
  })

  it('gives two people different answers to the identical question', () => {
    const question = { metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-07' } as const
    expect(alice.series(question).map((p) => p.value)).not.toEqual(bart.series(question).map((p) => p.value))
  })

  it("returns nothing for a person with no rows rather than somebody else's", () => {
    seedPerson(test.db, 'carol')
    const carol = new PersonQuery(test.db, 'carol')
    expect(carol.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-28' })).toEqual([])
    expect(carol.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-29' })).toBeNull()
    expect(carol.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-15', to: '2026-08-21' }).suppressed).toBe(true)
  })
})
