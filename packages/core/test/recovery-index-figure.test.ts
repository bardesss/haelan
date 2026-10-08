import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readRecoveryInput } from '../src/query/recoveryInput.ts'
import { recoveryIndexSeries, RECOVERY_USUAL_BAND } from '../src/api/recoveryIndex.ts'
import { recoveryIndexFigure, recoveryUsualBaseline } from '../src/query/recoveryIndexFigure.ts'
import { periodFigureOf } from '../src/query/periodFigure.ts'
import { datesIn, minDate, periodBounds } from '../src/query/periodBounds.ts'
import { readSpan } from '../src/query/periodRead.ts'
import { BASELINE_WINDOW_DAYS } from '../src/query/baseline.ts'

let test: TestDatabase
beforeEach(() => { test = createTestDatabase(); seedPerson(test.db, 'p1') })
afterEach(() => test.cleanup())

const seed = (metric: string, source: string, from: string, to: string, value: (date: string, i: number) => number) => {
  const rows = datesIn({ from, to }).map((localDate, i) => ({
    personId: 'p1', localDate, metric, agg: 'last', source, value: value(localDate, i), coverage: 1, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }))
  for (let i = 0; i < rows.length; i += 200) test.db.insert(daily).values(rows.slice(i, i + 200)).run()
}

describe('recoveryUsualBaseline', () => {
  it('is the usual band as a centre and spread, standing on a full window, never thin', () => {
    expect(recoveryUsualBaseline()).toEqual({ center: 49, spread: 13, n: BASELINE_WINDOW_DAYS, thin: false })
  })

  it('judges a day at 35 below, 36 and 62 within, 63 above', () => {
    const band = recoveryUsualBaseline()
    const values = new Map([['2026-08-03', 35], ['2026-08-04', 36], ['2026-08-05', 62], ['2026-08-06', 63]])
    const dailyBands = new Map(datesIn({ from: '2026-08-01', to: '2026-08-31' }).map((d) => [d, band] as const))
    const figure = periodFigureOf({
      metric: 'recovery_index', unit: 'score', precision: 0, direction: 'up', range: 'month', anchor: '2026-08-15',
      lastDay: '2026-08-31', values, dailyBands, additive: false,
    })
    const on = (date: string) => figure.daily.find((p) => p.from === date)!
    expect(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'].map((d) => [on(d).standing, on(d).judged]))
      .toEqual([['below', 'worse'], ['within', null], ['within', null], ['above', 'better']])
    expect(figure.counts).toEqual({ within: 2, above: 1, below: 1, unjudged: 0 })
    expect(on('2026-08-04').band).toEqual({ center: 49, low: RECOVERY_USUAL_BAND.low, high: RECOVERY_USUAL_BAND.high, thin: false })
  })
})

describe('recoveryIndexFigure', () => {
  const range = 'month' as const
  const anchor = '2026-08-15'
  const bounds = periodBounds(range, anchor)
  const span = readSpan(range, bounds)

  it('scores merged rows only, bands every day so far with the usual band, and keeps every scored day', () => {
    // Merged rows: HRV and resting heart rate alternate either side of a level, then swing in August.
    seed('daily_hrv', 'merged', '2026-04-01', '2026-08-31', (d, i) => (d >= '2026-08-01' ? 40 + (i % 5) * 4 : 48 + (i % 2 === 0 ? 2 : -2)))
    seed('resting_heart_rate', 'merged', '2026-04-01', '2026-08-31', (d, i) => 55 + (i % 2 === 0 ? 1 : -1))
    // A device's own rows, far from the merge: the index never reads them.
    seed('daily_hrv', 'watch', '2026-04-01', '2026-08-31', () => 100)
    const q = new PersonQuery(test.db, 'p1')
    const lastDay = '2026-08-20'
    const read = recoveryIndexFigure(q, { range, anchor, bounds, span, lastDay })

    const expected = recoveryIndexSeries(readRecoveryInput(q, { from: span.from, to: lastDay }).input, { from: span.from, to: lastDay })
    const enough = [...expected].flatMap(([date, day]) => (day.enough ? [[date, day.score] as const] : []))
    expect(enough.length).toBeGreaterThan(0)
    expect([...read.scores].map(([date, day]) => [date, day.score])).toEqual(enough)

    const { figure } = read
    expect([figure.metric, figure.unit, figure.precision, figure.direction]).toEqual(['recovery_index', 'score', 0, 'up'])
    expect(figure.daily.map((p) => p.from)).toEqual(datesIn({ from: bounds.from, to: minDate(bounds.to, lastDay) }))
    expect(figure.daily.every((p) => p.band?.low === RECOVERY_USUAL_BAND.low && p.band.high === RECOVERY_USUAL_BAND.high && !p.band.thin)).toBe(true)
    for (const p of figure.daily) {
      const score = read.scores.get(p.from)?.score ?? null
      expect([p.from, p.value]).toEqual([p.from, score])
      const standing = score === null ? null : score < 36 ? 'below' : score > 62 ? 'above' : 'within'
      expect([p.from, p.standing]).toEqual([p.from, standing])
    }
    expect(figure.days).toBeGreaterThan(0)
    const judged = figure.counts.within + figure.counts.above + figure.counts.below
    expect([judged, figure.counts.unjudged]).toEqual([figure.days, 0])
  })
})
