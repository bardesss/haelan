import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, metricSpec, readHrvDeviation, seedPerson, schema, DERIVATION_VERSION } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { hrvDayOf, hrvDeviationTool } from '../src/mcp/tools/hrvDeviation.ts'
import { roundHrvDeviationDay } from '../src/routes/v1/shared.ts'

type Out = {
  days: Array<{ localDate: string, measured: boolean, reason: string | null, rolling: number | null, low: number | null, high: number | null, side: string | null }>
  run: { side: string, days: number, filledDays: number } | null
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

describe('hrv_deviation tool', () => {
  let test: TestDatabase
  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
  })
  afterEach(() => test.cleanup())

  function seedHrv(localDate: string, value: number): void {
    test.db.insert(schema.daily).values({
      personId: 'robin', localDate, metric: 'daily_hrv', agg: 'last', source: 'merged', value,
      coverage: null, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
  }

  it('declares the window parameters and nothing else', () => {
    expect(hrvDeviationTool.name).toBe('hrv_deviation')
    expect(Object.keys(hrvDeviationTool.inputSchema).sort()).toEqual(['from', 'to'])
  })

  it('answers a run below the band after a seeded dip', () => {
    // 80 days alternating 50 and 60, then ten days at 30.
    const start = '2026-05-01'
    for (let i = 0; i < 80; i++) seedHrv(addDays(start, i), i % 2 === 0 ? 50 : 60)
    for (let i = 80; i < 90; i++) seedHrv(addDays(start, i), 30)
    const to = addDays(start, 89)
    const out = hrvDeviationTool.run(new PersonQuery(test.db, 'robin'), { from: to, to }) as Out
    expect(out.run?.side).toBe('below')
    expect(out.run!.days).toBeGreaterThanOrEqual(3)
    expect(out.days).toHaveLength(1)
    expect(out.days[0]).toMatchObject({ measured: true, reason: null, side: 'below' })
    expect(out.days[0]!.low).toBeLessThan(out.days[0]!.high!)
  })

  it('keeps an unmeasured day in the answer with its reason and nulls', () => {
    const out = hrvDeviationTool.run(new PersonQuery(test.db, 'robin'), { from: '2026-08-02', to: '2026-08-03' }) as Out
    expect(out.days).toEqual([
      { localDate: '2026-08-02', measured: false, reason: 'thin-week', rolling: null, low: null, high: null, side: null },
      { localDate: '2026-08-03', measured: false, reason: 'thin-week', rolling: null, low: null, high: null, side: null },
    ])
    expect(out.run).toBeNull()
  })

  it('answers a run above the band after a seeded rise', () => {
    const start = '2026-05-01'
    for (let i = 0; i < 80; i++) seedHrv(addDays(start, i), i % 2 === 0 ? 50 : 60)
    for (let i = 80; i < 90; i++) seedHrv(addDays(start, i), 90)
    const to = addDays(start, 89)
    const out = hrvDeviationTool.run(new PersonQuery(test.db, 'robin'), { from: to, to }) as Out
    expect(out.run?.side).toBe('above')
    expect(out.run!.days).toBeGreaterThanOrEqual(3)
    expect(out.days[0]).toMatchObject({ measured: true, side: 'above' })
  })

  it('rounds rolling, low and high to the daily_hrv precision', () => {
    const start = '2026-05-01'
    for (let i = 0; i < 80; i++) seedHrv(addDays(start, i), i % 2 === 0 ? 50 : 60)
    // Alternating 31 and 37: the log-scale mean is sqrt(1147), 33.8673..., not a round figure.
    for (let i = 80; i < 90; i++) seedHrv(addDays(start, i), i % 2 === 0 ? 31 : 37)
    const to = addDays(start, 89)
    const q = new PersonQuery(test.db, 'robin')
    const raw = readHrvDeviation(q, { from: to, to }).days[0]
    if (!raw || !raw.measured) throw new Error('expected a measured day')
    const day = (hrvDeviationTool.run(q, { from: to, to }) as Out).days[0]!
    const precision = metricSpec('daily_hrv')!.precision
    expect(Number(raw.rolling.toFixed(precision + 3))).not.toBe(Number(raw.rolling.toFixed(precision)))
    expect(day.rolling).toBe(Number(raw.rolling.toFixed(precision)))
    expect(day.low).toBe(Number(raw.band.low.toFixed(precision)))
    expect(day.high).toBe(Number(raw.band.high.toFixed(precision)))
  })
})

describe('hrv_deviation day rows', () => {
  it('judge a day on its band edge as the HTTP routes do, on the rounded numbers', () => {
    // 50.4 is above 49.96, but it is sent as 50 against a high of 50.
    const raw = { localDate: '2026-08-31', measured: true as const, rolling: 50.4, band: { low: 40.04, high: 49.96 }, side: 'above' as const }
    expect(hrvDayOf(raw)).toEqual({ localDate: '2026-08-31', measured: true, reason: null, rolling: 50, low: 40, high: 50, side: 'within' })
    expect(roundHrvDeviationDay(raw)).toEqual({ localDate: '2026-08-31', measured: true, rolling: 50, band: { low: 40, high: 50 }, side: 'within' })
  })
})
