import type { Baseline } from './baseline.ts'
import { INSIGHT_MIN_DAY_FRACTION } from './insights.ts'
import { judge, standingOf, toGlanceBaseline } from './glance.ts'
import type { FigureDirection, GlanceBaseline, GlanceStanding, Judged } from './glance.ts'
import { usualOf } from './pageFigure.ts'
import { datesIn, earlierBlocks, periodBounds, weeksIn } from './periodBounds.ts'
import type { DateSpan, PeriodRange } from './periodBounds.ts'

/**
 * The pure half of a period read on the Sleep and Activity overview pages: one figure for a week,
 * month, three months or year, judged against periods of its own length.
 *
 * The usual is made of period means, not of single days. A month's mean varies far less than a
 * night does, so a band drawn from nights would call an ordinary month unusual whenever it is
 * compared with the spread of single days. A year has no earlier years to speak of, so it is judged
 * against the previous year's four quarters.
 *
 * `countsOf` runs twice: once here on full precision, and once more in the route after the points
 * are rounded for the wire, so the counts printed always agree with the dots the page draws.
 */

export interface PeriodWindow { unit: 'week' | 'month' | 'quarter' | 'year', count: number, from: string, to: string }
export interface PeriodUsual extends GlanceBaseline { window: PeriodWindow, periods: number }
export interface DayCounts { within: number, above: number, below: number, unjudged: number }
export interface PeriodStripPoint {
  from: string, to: string
  value: number | null
  band: GlanceBaseline | null
  standing: GlanceStanding | null
  judged: Judged
  days: number
}
export type PeriodReason = 'no-data' | 'too-few-days' | 'thin-usual' | null
export interface PeriodFigure {
  metric: string, unit: string, precision: number, direction: FigureDirection
  per: 'day' | 'week'
  value: number | null
  total: number | null
  days: number
  usual: PeriodUsual | null
  standing: GlanceStanding | null
  judged: Judged
  reason: PeriodReason
  counts: DayCounts
  daily: PeriodStripPoint[]
  weekly: PeriodStripPoint[] | null
}
export interface PeriodHigh { localDate: string, value: number, good: boolean }
export interface PeriodChange { from: string, to: string, value: number | null, delta: number | null }
export interface PeriodHeader { range: PeriodRange, from: string, to: string, today: string, periodDays: number, daysSoFar: number, partial: boolean }

export const PERIOD_MIN_PERIODS: Record<PeriodRange, number> = { week: 8, month: 8, '3months': 3, year: 3 }
export const PERIOD_MIN_DAYS = 3

export interface PeriodFigureInput {
  metric: string, unit: string, precision: number, direction: FigureDirection
  range: PeriodRange, anchor: string
  lastDay: string
  values: ReadonlyMap<string, number>
  dailyBands: ReadonlyMap<string, Baseline | null>
  per?: 'day' | 'week'
  additive: boolean
}

const earlier = (a: string, b: string) => (a < b ? a : b)

function scaledBand(band: GlanceBaseline | null, scale: number): GlanceBaseline | null {
  return band === null ? null : { center: band.center * scale, low: band.low * scale, high: band.high * scale, thin: band.thin }
}

/** The mean of the values in a span up to lastDay; a mean only when 70% of those dates carry one. */
export function blockMean(values: ReadonlyMap<string, number>, span: DateSpan, lastDay: string): { mean: number | null, days: number } {
  const to = earlier(span.to, lastDay)
  if (to < span.from) return { mean: null, days: 0 }
  const dates = datesIn({ from: span.from, to })
  const present = dates.flatMap((d) => { const v = values.get(d); return v === undefined ? [] : [v] })
  if (present.length === 0 || present.length / dates.length < INSIGHT_MIN_DAY_FRACTION) return { mean: null, days: present.length }
  return { mean: present.reduce((s, v) => s + v, 0) / present.length, days: present.length }
}

export function periodUsual(values: ReadonlyMap<string, number>, range: PeriodRange, bounds: DateSpan, scale: number): PeriodUsual | null {
  const { unit, blocks } = earlierBlocks(range, bounds)
  // Earlier blocks are all finished, so nothing bounds them from above.
  const means = blocks.flatMap((b) => {
    const { mean } = blockMean(values, b, b.to)
    return mean === null ? [] : [mean * scale]
  })
  const usual = usualOf(means, PERIOD_MIN_PERIODS[range])
  if (usual === null) return null
  return { ...usual, window: { unit, count: blocks.length, from: blocks[0]!.from, to: blocks[blocks.length - 1]!.to }, periods: means.length }
}

export function countsOf(daily: readonly PeriodStripPoint[]): DayCounts {
  const counts: DayCounts = { within: 0, above: 0, below: 0, unjudged: 0 }
  for (const p of daily) {
    if (p.value === null) continue
    if (p.standing === null) counts.unjudged += 1
    else counts[p.standing] += 1
  }
  return counts
}

export function highOf(daily: readonly PeriodStripPoint[]): PeriodHigh | null {
  let best: PeriodStripPoint | null = null
  for (const p of daily) if (p.value !== null && (best === null || p.value > best.value!)) best = p
  return best === null ? null : { localDate: best.from, value: best.value!, good: best.judged === 'better' }
}

export function changeOf(
  values: ReadonlyMap<string, number>, span: DateSpan, current: number | null, lastDay: string, scale: number,
): PeriodChange {
  const { mean } = blockMean(values, span, lastDay)
  const value = mean === null ? null : mean * scale
  return { from: span.from, to: span.to, value, delta: current !== null && value !== null ? current - value : null }
}

export function periodFigureOf(input: PeriodFigureInput): PeriodFigure {
  const { range, values, lastDay, direction } = input
  const per = input.per ?? 'day'
  const scale = per === 'week' ? 7 : 1
  const bounds = periodBounds(range, input.anchor)
  const end = earlier(bounds.to, lastDay)
  const running = end < bounds.to
  const dates = end < bounds.from ? [] : datesIn({ from: bounds.from, to: end })

  const present = dates.flatMap((d) => { const v = values.get(d); return v === undefined ? [] : [v] })
  const sum = present.reduce((s, v) => s + v, 0)
  const days = present.length
  const value = days === 0 ? null : (sum / days) * scale
  const usual = periodUsual(values, range, bounds, scale)

  let standing: GlanceStanding | null = null
  let reason: PeriodReason
  // No data at all is named as such, even while the period runs; too few days is for a start with something in it.
  if (days === 0) reason = 'no-data'
  else if (running && days < PERIOD_MIN_DAYS) reason = 'too-few-days'
  else {
    standing = standingOf(value, usual, false)
    reason = usual === null || usual.thin ? 'thin-usual' : null
  }

  const point = (span: DateSpan, v: number | null, band: GlanceBaseline | null, n: number): PeriodStripPoint => {
    const st = standingOf(v, band, false)
    return { from: span.from, to: span.to, value: v, band, standing: st, judged: judge(st, direction), days: n }
  }

  const daily = dates.map((date) => {
    const v = values.get(date)
    const band = scaledBand(toGlanceBaseline(input.dailyBands.get(date) ?? null), scale)
    return point({ from: date, to: date }, v === undefined ? null : v * scale, band, v === undefined ? 0 : 1)
  })

  let weekly: PeriodStripPoint[] | null = null
  if (range === '3months' || range === 'year') {
    weekly = dates.length === 0 ? [] : weeksIn({ from: bounds.from, to: end }).map((week) => {
      const { mean, days: n } = blockMean(values, week, lastDay)
      // The full Monday-Sunday week holding the point, so earlierBlocks gives the twelve weeks before it.
      const own = periodUsual(values, 'week', periodBounds('week', week.from), scale)
      const band: GlanceBaseline | null = own === null ? null : { center: own.center, low: own.low, high: own.high, thin: own.thin }
      return point(week, mean === null ? null : mean * scale, band, n)
    })
  }

  return {
    metric: input.metric, unit: input.unit, precision: input.precision, direction, per,
    value, total: input.additive && days > 0 ? sum : null, days, usual, standing,
    judged: judge(standing, direction), reason, counts: countsOf(daily), daily, weekly,
  }
}
