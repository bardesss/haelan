import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION, insertSample,
} from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { CATALOGUE } from '../src/mcp/catalogue.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
  test.db.insert(schema.sources).values({
    id: 'watch', personId: 'robin', externalId: 'watch', displayName: 'Fitbit Sense',
    kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => test.cleanup())

const tool = (name: string) => {
  const found = CATALOGUE.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool named ${name}`)
  return found
}
const q = () => new PersonQuery(test.db, 'robin')

function seedDaily(input: {
  localDate: string
  value: number
  metric?: string
  agg?: string
  source?: string
}): void {
  test.db.insert(schema.daily).values({
    personId: 'robin',
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: input.agg ?? 'sum',
    source: input.source ?? 'merged',
    value: input.value,
    coverage: null,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
    updatedAtMs: null,
  }).run()
}

function dateOf(day: number): string {
  const base = new Date(Date.UTC(2026, 0, 1))
  base.setUTCDate(base.getUTCDate() + day)
  return base.toISOString().slice(0, 10)
}

describe('describe_person', () => {
  it('answers the bound person, their timezone and their sources', () => {
    const out = tool('describe_person').run(q(), {}) as {
      personId: string, timezone: string, sources: { id: string, name: Record<string, unknown> }[]
    }
    expect(out.personId).toBe('robin')
    expect(out.timezone).toBe('Europe/Amsterdam')
    expect(out.sources).toHaveLength(1)
    expect(out.sources[0]!.id).toBe('watch')
  })

  it('puts a source name in the untrusted envelope, because a device chose it', () => {
    const out = tool('describe_person').run(q(), {}) as {
      sources: { name: { untrustedText: string | null } }[]
    }
    expect(out.sources[0]!.name.untrustedText).toBe('Fitbit Sense')
  })
})

describe('list_metrics', () => {
  it('names every metric with the aggregates the catalogue allows it', () => {
    const out = tool('list_metrics').run(q(), {}) as { metrics: { metric: string, aggs: string[] }[] }
    const steps = out.metrics.find((m) => m.metric === 'steps')
    expect(steps).toBeDefined()
    expect(steps!.aggs.length).toBeGreaterThan(0)
  })
})

describe('query_series', () => {
  it('answers the seeded points with a summary and no reduction', () => {
    seedDaily({ localDate: '2026-08-01', value: 1000 })
    seedDaily({ localDate: '2026-08-02', value: 2000 })
    seedDaily({ localDate: '2026-08-03', value: 3000 })

    const out = tool('query_series').run(q(), {
      metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-03',
    }) as {
      points: { localDate: string, value: number }[]
      reduction: unknown
      summary: { n: number }
    }

    expect(out.points).toEqual([
      { localDate: '2026-08-01', value: 1000, coverage: null, source: 'merged' },
      { localDate: '2026-08-02', value: 2000, coverage: null, source: 'merged' },
      { localDate: '2026-08-03', value: 3000, coverage: null, source: 'merged' },
    ])
    expect(out.summary.n).toBe(3)
    expect(out.reduction).toBeNull()
  })

  it('caps a wide range to the requested budget and says it thinned', () => {
    for (let i = 0; i < 400; i += 1) {
      seedDaily({ localDate: dateOf(i), value: i })
    }

    const out = tool('query_series').run(q(), {
      metric: 'steps', agg: 'sum', from: dateOf(0), to: dateOf(399), points: 50,
    }) as {
      points: unknown[]
      reduction: { from: number, to: number, method: string } | null
    }

    expect(out.points.length).toBeLessThanOrEqual(50)
    expect(out.reduction).not.toBeNull()
    expect(out.reduction!.from).toBe(400)
  })
})

describe('get_intraday', () => {
  it('returns a day of samples with a summary and no reduction at the default budget', () => {
    const nineAm = Date.UTC(2026, 7, 10, 7, 0) // 09:00 local at +120 on 2026-08-10.
    for (let i = 0; i < 90; i += 1) {
      for (const agg of ['min', 'mean', 'max'] as const) {
        insertSample(test.db, {
          personId: 'robin', sourceId: 'watch', metric: 'heart_rate',
          utcMs: nineAm + i * 60_000, tzOffsetMinutes: 120, agg, value: 100 + i,
        })
      }
    }

    const out = tool('get_intraday').run(q(), {
      metric: 'heart_rate', localDate: '2026-08-10',
    }) as {
      points: { utcMs: number, mean: number | null }[]
      reduction: unknown
      summary: { n: number }
    }

    expect(out.points).toHaveLength(90)
    expect(out.points[0]!.mean).toBe(100)
    expect(out.summary.n).toBe(90)
    expect(out.reduction).toBeNull()
  })
})

describe('get_sleep', () => {
  const H = 3_600_000
  // 23:00 local on 2026-08-09 at +120 is 21:00Z, so the night starts before the date it belongs to.
  const BEDTIME = Date.UTC(2026, 7, 9, 21, 0)

  it('returns the night filed under the morning it ends on, with its stage segments', () => {
    test.db.insert(schema.sessions).values({
      id: 'night-1', personId: 'robin', sourceId: 'watch', kind: 'sleep', externalId: 'night-1',
      startMs: BEDTIME, startOffsetMinutes: 120, endMs: BEDTIME + 8 * H, endOffsetMinutes: 120,
      localDate: '2026-08-10', rawPayloadId: null,
      attrs: JSON.stringify({ mainSleep: true }),
    }).run()
    test.db.insert(schema.sessionSegments).values([
      { id: 'seg-1', sessionId: 'night-1', stage: 'LIGHT', startMs: BEDTIME, endMs: BEDTIME + 5 * H },
      { id: 'seg-2', sessionId: 'night-1', stage: 'DEEP', startMs: BEDTIME + 5 * H, endMs: BEDTIME + 8 * H },
    ]).run()

    const out = tool('get_sleep').run(q(), { from: '2026-08-10', to: '2026-08-10' }) as {
      nights: { localDate: string, segments: { stage: string, startMs: number, endMs: number }[] }[]
    }

    expect(out.nights).toHaveLength(1)
    expect(out.nights[0]!.localDate).toBe('2026-08-10')
    expect(out.nights[0]!.segments.map((s) => s.stage)).toEqual(['LIGHT', 'DEEP'])
  })
})

describe('the catalogue itself', () => {
  it('has no duplicate tool names', () => {
    const names = CATALOGUE.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every tool a description that tells an agent when to reach for it', () => {
    for (const t of CATALOGUE) expect(t.description.length).toBeGreaterThan(40)
  })
})
