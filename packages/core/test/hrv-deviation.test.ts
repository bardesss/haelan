import { describe, expect, it } from 'vitest'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import {
  hrvBaselineWindow, hrvDeviationRun, hrvDeviationSeries, hrvDeviationWindowStart,
} from '../src/query/hrvDeviation.ts'
import type { HrvReading } from '../src/query/hrvDeviation.ts'

const D = '2026-08-31'
const day = (back: number) => shiftLocalDate(D, -back)

/** Alternating 45/55 ms on every day from `fromBack` down to `toBack` days before D, inclusive. */
function usual(fromBack: number, toBack: number): HrvReading[] {
  const out: HrvReading[] = []
  for (let back = fromBack; back >= toBack; back -= 1) out.push({ localDate: day(back), value: back % 2 === 0 ? 45 : 55 })
  return out
}
/** A steady decline of `perDay` on the log scale, starting at `start` ms on `fromBack`. */
function decline(fromBack: number, toBack: number, start: number, perDay: number): HrvReading[] {
  const out: HrvReading[] = []
  for (let back = fromBack; back >= toBack; back -= 1) out.push({ localDate: day(back), value: start * Math.exp(-perDay * (fromBack - back)) })
  return out
}
function flat(fromBack: number, toBack: number, value: number, filled = false): HrvReading[] {
  const out: HrvReading[] = []
  for (let back = fromBack; back >= toBack; back -= 1) out.push({ localDate: day(back), value, filled })
  return out
}
const on = (readings: HrvReading[], date = D) => hrvDeviationSeries(readings, { from: date, to: date })[0]!

describe('hrvBaselineWindow', () => {
  it('is the 60 days ending the day before the week begins', () => {
    expect(hrvBaselineWindow(D)).toEqual({ from: day(66), to: day(7) })
  })
})

describe('hrvDeviationWindowStart', () => {
  it('reaches back far enough to score every day of a 60-day lookback from `from`', () => {
    expect(hrvDeviationWindowStart(D)).toBe(day(125))
  })
})

describe('hrvDeviationSeries', () => {
  it('judges a week of 40 ms below a usual of 45/55', () => {
    const result = on([...usual(66, 7), ...flat(6, 0, 40)])
    expect(result).toMatchObject({ measured: true, side: 'below' })
  })

  it('judges a week of 62 ms above it, the mirror of below', () => {
    expect(on([...usual(66, 7), ...flat(6, 0, 62)])).toMatchObject({ measured: true, side: 'above' })
  })

  it('judges a week shaped like the baseline within it', () => {
    expect(on(usual(66, 0))).toMatchObject({ measured: true, side: 'within' })
  })

  it('reports rolling and band in ms, the band wider above the centre than below it', () => {
    const result = on(usual(66, 0))
    if (!result.measured) throw new Error('expected measured')
    expect(result.band.low).toBeCloseTo(47.4, 0)
    expect(result.band.high).toBeCloseTo(52.4, 0)
    const centre = Math.exp((Math.log(45) + Math.log(55)) / 2)
    expect(result.band.high - centre).toBeGreaterThan(centre - result.band.low)
  })

  it('needs four readings in the week: three is thin, four is measured', () => {
    const base = usual(66, 7)
    expect(on([...base, ...flat(2, 0, 40)])).toEqual({ localDate: D, measured: false, reason: 'thin-week' })
    expect(on([...base, ...flat(3, 0, 40)])).toMatchObject({ measured: true })
  })

  it('does not let a day of the week into the baseline it is judged against', () => {
    // 42 days is exactly the 70% of 60 baselineOf needs. Ending on D-7 they all count; shifted one
    // day later, D-6 falls outside the window, 41 remain and the baseline is thin. A window that
    // ended at D-1 instead would count both, and the second assertion would go red.
    const week = flat(6, 0, 40)
    expect(on([...usual(48, 7), ...week])).toMatchObject({ measured: true })
    expect(on([...usual(47, 7), ...week])).toEqual({ localDate: D, measured: false, reason: 'thin-baseline' })
  })

  it('calls a baseline with no spread flat, not thin', () => {
    expect(on([...flat(66, 7, 50), ...flat(6, 0, 40)])).toEqual({ localDate: D, measured: false, reason: 'flat-baseline' })
  })

  it('reads on ln: one very high night lifts a raw mean over the band and the log mean not', () => {
    // Raw: baseline mean 50, spread ~5.04, band high ~52.5; the week's raw mean is ~53.1, above it.
    // ln: the week's mean is ~3.943, under the ln band's high of ~3.958, so within.
    const week = [...flat(6, 1, 47), { localDate: D, value: 90 }]
    expect(on([...usual(66, 7), ...week])).toMatchObject({ measured: true, side: 'within' })
  })
})

describe('hrvDeviationRun', () => {
  it('is null while the week sits within the band', () => {
    expect(hrvDeviationRun(usual(125, 0), D)).toBeNull()
  })

  it('counts measured days below, from the day the rolling mean first crossed', () => {
    const run = hrvDeviationRun([...usual(125, 10), ...flat(9, 0, 30)], D)
    expect(run).not.toBeNull()
    expect(run!.side).toBe('below')
    expect(run!.days).toBe(10)
    expect(run!.since).toBe(day(9))
    expect(run!.capped).toBe(false)
  })

  it('is null below the minimum run of three days', () => {
    // A two-day drop to 20 ms pulls the week mean under the band on D-1 and D only.
    const readings = [...usual(125, 2), ...flat(1, 0, 20)]
    const series = hrvDeviationSeries(readings, { from: day(2), to: D })
    expect(series.map((d) => (d.measured ? d.side : null))).toEqual(['within', 'below', 'below'])
    expect(hrvDeviationRun(readings, D)).toBeNull()
  })

  it('stops at a day on the other side', () => {
    const readings = [...usual(125, 21), ...flat(20, 11, 70), ...flat(10, 0, 25)]
    const run = hrvDeviationRun(readings, D)!
    expect(run.side).toBe('below')
    const series = hrvDeviationSeries(readings, { from: run.since, to: D })
    expect(series.every((d) => !d.measured || d.side === 'below')).toBe(true)
    const before = hrvDeviationSeries(readings, { from: shiftLocalDate(run.since, -1), to: shiftLocalDate(run.since, -1) })[0]!
    expect(before.measured && before.side).not.toBe('below')
  })

  it('skips an unmeasured day without breaking or extending the run', () => {
    // Four days without a reading in the middle of a long dip make D-12 thin-week; the run carries
    // on across it, and it is not counted.
    const dip = flat(20, 0, 30).filter((r) => ![day(12), day(13), day(14), day(15)].includes(r.localDate))
    const readings = [...usual(125, 21), ...dip]
    const series = hrvDeviationSeries(readings, { from: day(20), to: D })
    const unmeasured = series.filter((d) => !d.measured).length
    expect(unmeasured).toBeGreaterThan(0)
    const run = hrvDeviationRun(readings, D)!
    const measuredBelow = hrvDeviationSeries(readings, { from: run.since, to: D }).filter((d) => d.measured && d.side === 'below').length
    expect(run.days).toBe(measuredBelow)
    expect(run.since <= day(16)).toBe(true)
  })

  it('caps the lookback at 60 days and says so', () => {
    // A flat dip longer than its baseline swallows itself: by D its baseline is all dip, and it reads
    // within. Only a steady decline stays below for 60 days. At 1% a day on the log scale, each
    // week sits ~0.33 below the centre of the 60 days behind it, against a half-band of ~0.09.
    const run = hrvDeviationRun([...usual(200, 130), ...decline(129, 0, 50, 0.01)], D)!
    expect(run.side).toBe('below')
    expect(run.days).toBe(60)
    expect(run.capped).toBe(true)
  })

  it('does not call a run capped when the lookback starts on unmeasured days', () => {
    // The lookback's first days (D-59..D-35) have no baseline behind them, so they are thin, not
    // below; the walk running out there is not the run reaching the cap.
    const readings = [...usual(80, 35), ...flat(34, 0, 30)]
    const run = hrvDeviationRun(readings, D)!
    expect(run.side).toBe('below')
    expect(run.days).toBe(33)
    expect(run.capped).toBe(false)
  })

  it('counts the run days whose HRV was filled', () => {
    const readings = [...usual(125, 10), ...flat(9, 3, 30), ...flat(2, 0, 30, true)]
    expect(hrvDeviationRun(readings, D)!.filledDays).toBe(3)
  })

  it('counts the last seven single nights outside the band on the run side', () => {
    const readings = [...usual(125, 10), ...flat(9, 0, 30)]
    expect(hrvDeviationRun(readings, D)!.sideNights).toBe(7)
  })

  it('mirrors below for above', () => {
    const run = hrvDeviationRun([...usual(125, 10), ...flat(9, 0, 80)], D)!
    expect(run.side).toBe('above')
    expect(run.sideNights).toBe(7)
  })
})
