import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION } from '@haelan/core'
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

describe('the catalogue itself', () => {
  it('has no duplicate tool names', () => {
    const names = CATALOGUE.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every tool a description that tells an agent when to reach for it', () => {
    for (const t of CATALOGUE) expect(t.description.length).toBeGreaterThan(40)
  })
})
