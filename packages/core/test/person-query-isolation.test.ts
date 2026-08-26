import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { daily, samples, sessions, sources } from '../src/db/schema/index.ts'
import type { SessionKind } from '../src/db/schema/index.ts'

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
    const { points } = alice.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-28' })
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
    expect(alice.series(question).points.map((p) => p.value))
      .not.toEqual(bart.series(question).points.map((p) => p.value))
  })

  it("returns nothing for a person with no rows rather than somebody else's", () => {
    seedPerson(test.db, 'carol')
    const carol = new PersonQuery(test.db, 'carol')
    expect(carol.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-28' }).points).toEqual([])
    expect(carol.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-29' })).toBeNull()
    expect(carol.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-15', to: '2026-08-21' }).suppressed).toBe(true)
  })

  it('smooths a trend only from its own person', () => {
    // Both people carry a flat, constant series with different values in the beforeEach above.
    // A leak would pull bart's 9000 into alice's line, or drag alice's centre toward 5000.
    const points = alice.trend({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-10' })
    expect(points.every((p) => p.value === 1000)).toBe(true)
  })
})

describe('PersonQuery isolation, the readers bound to samples and sessions', () => {
  const insertSource = (id: string, personId: string) =>
    test.db.insert(sources).values({
      id, personId, externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()

  const insertSession = (o: {
    id: string, kind: SessionKind, personId: string, sourceId: string,
    startMs: number, endMs: number, localDate: string,
  }) =>
    test.db.insert(sessions).values({
      id: o.id, personId: o.personId, sourceId: o.sourceId, kind: o.kind, externalId: o.id,
      startMs: o.startMs, startOffsetMinutes: 0, endMs: o.endMs, endOffsetMinutes: 0,
      localDate: o.localDate, attrs: '{}', rawPayloadId: null,
    }).run()

  const H = 3_600_000
  const AT = Date.UTC(2026, 7, 1, 9, 0)

  it('reads intraday samples only for its own person', () => {
    insertSource('alice-watch', 'alice')
    insertSource('bart-watch', 'bart')
    test.db.insert(samples).values([
      {
        personId: 'alice', sourceId: 'alice-watch', metric: 'heart_rate', utcMs: AT,
        tzOffsetMinutes: 0, agg: 'mean', value: 60, n: 1, rawPayloadId: null,
      },
      {
        personId: 'bart', sourceId: 'bart-watch', metric: 'heart_rate', utcMs: AT,
        tzOffsetMinutes: 0, agg: 'mean', value: 150, n: 1, rawPayloadId: null,
      },
    ]).run()

    const out = alice.intraday({ metric: 'heart_rate', localDate: '2026-08-01' })
    expect(out.points.map((p) => p.mean)).toEqual([60])
  })

  it('reads sleep nights only for its own person', () => {
    insertSource('alice-watch', 'alice')
    insertSource('bart-watch', 'bart')
    insertSession({
      id: 'alice-night', kind: 'sleep', personId: 'alice', sourceId: 'alice-watch',
      startMs: AT, endMs: AT + 8 * H, localDate: '2026-08-01',
    })
    insertSession({
      id: 'bart-night', kind: 'sleep', personId: 'bart', sourceId: 'bart-watch',
      startMs: AT, endMs: AT + 8 * H, localDate: '2026-08-01',
    })

    const nights = alice.sleepNights({ from: '2026-08-01', to: '2026-08-01' })
    expect(nights).toHaveLength(1)
    expect(nights[0]?.sessionIds).toEqual(['alice-night'])
  })

  it('reads changes only for its own person', () => {
    // Different metrics, deliberately: a leak would surface as bart's pair appearing alongside
    // alice's, which same-shaped rows on the same metric would not make visible.
    test.db.insert(daily).values([
      {
        personId: 'alice', localDate: '2026-08-01', metric: 'weight', agg: 'mean', source: 'merged',
        value: 70, coverage: null, sourceMix: null, derivationVersion: 4, updatedAtMs: 5_000,
      },
      {
        personId: 'bart', localDate: '2026-08-01', metric: 'body_fat', agg: 'mean', source: 'merged',
        value: 20, coverage: null, sourceMix: null, derivationVersion: 4, updatedAtMs: 5_000,
      },
    ]).run()

    const result = alice.changes({ since: 1_000 })
    expect(result.items).toEqual([{ localDate: '2026-08-01', metric: 'weight' }])
  })

  it('reads sessions only for its own person', () => {
    insertSource('alice-watch', 'alice')
    insertSource('bart-watch', 'bart')
    insertSession({
      id: 'alice-run', kind: 'exercise', personId: 'alice', sourceId: 'alice-watch',
      startMs: AT, endMs: AT + H, localDate: '2026-08-01',
    })
    insertSession({
      id: 'bart-run', kind: 'exercise', personId: 'bart', sourceId: 'bart-watch',
      startMs: AT, endMs: AT + H, localDate: '2026-08-01',
    })

    const out = alice.sessions({ kind: 'exercise', from: '2026-08-01', to: '2026-08-01' })
    expect(out.map((s) => s.id)).toEqual(['alice-run'])
  })
})
