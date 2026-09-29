import { METRICS } from '../derive/metrics.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import type { PersonQuery } from './personQuery.ts'
import { baselinesOver, baselineWindow } from './baseline.ts'
import type { Baseline } from './baseline.ts'
import { coverageIsMeaningful } from './coverageSignal.ts'
import { INSIGHT_MIN_COVERAGE } from './insights.ts'
import { FIGURE_METRIC_ALIAS } from './glance.ts'
import type { FigureDirection } from './glance.ts'
import { datesIn, daysIn, earlierBlocks, minDate, periodBounds, stepPeriod, yearEarlierDate } from './periodBounds.ts'
import type { DateSpan, PeriodRange } from './periodBounds.ts'
import { changeOf, periodFigureOf } from './periodFigure.ts'
import type { PeriodChange, PeriodFigure, PeriodHeader } from './periodFigure.ts'

/**
 * The reads behind a period figure: one series per metric over the widest span any of the figure's
 * parts looks at, with every day's band worked out in memory from that same read. Never a read per
 * day, and never a second read for the bands: `PersonQuery.baselines` reads the series itself, so
 * calling it here would read each metric twice for the same rows.
 */
export interface PeriodSeries { values: Map<string, number>, bands: Map<string, Baseline | null> }


/**
 * The widest span a period's figures read: the earlier blocks it is judged against, the twelve
 * weeks before its first week (the weekly bands), the sixty days before its first day (the daily
 * bands), and the same period a year earlier (the year-on-year change). To the period's end.
 */
export function readSpan(range: PeriodRange, bounds: DateSpan): DateSpan {
  const firstWeek = periodBounds('week', shiftLocalDate(bounds.from, -7 * 12)).from
  return {
    from: [
      earlierBlocks(range, bounds).blocks[0]!.from,
      firstWeek,
      baselineWindow(bounds.from).from,
      yearEarlierDate(bounds.from),
    ].reduce(minDate),
    to: bounds.to,
  }
}

/** Every day's band for the period's days so far, from values already in hand; what `baselines` computes, without its read. */
export function bandsOver(values: ReadonlyMap<string, number>, bounds: DateSpan, lastDay: string): Map<string, Baseline | null> {
  const end = minDate(bounds.to, lastDay)
  return end < bounds.from ? new Map() : baselinesOver(values, datesIn({ from: bounds.from, to: end }))
}

export function readPeriodSeries(
  q: PersonQuery, o: { metric: string, agg: string, span: DateSpan, bounds: DateSpan, lastDay: string, source?: string },
): PeriodSeries {
  const { points } = q.series({ metric: o.metric, agg: o.agg, from: o.span.from, to: minDate(o.bounds.to, o.lastDay), source: o.source })
  // The same coverage rule `baselines` applies: a barely observed day is an undercount, not a reading.
  const judgeCoverage = coverageIsMeaningful(o.metric)
  const values = new Map(points
    .filter((p) => !(judgeCoverage && p.coverage !== null && p.coverage < INSIGHT_MIN_COVERAGE))
    .map((p) => [p.localDate, p.value]))
  return { values, bands: bandsOver(values, o.bounds, o.lastDay) }
}

export interface CatalogueFigureInput {
  metric: string, agg: string, range: PeriodRange, anchor: string, bounds: DateSpan, span: DateSpan, lastDay: string
  source?: string, per?: 'day' | 'week', additive?: boolean
}

/** A catalogue metric's figure and the series it was made from, for a caller that needs the values again. */
export function catalogueRead(q: PersonQuery, o: CatalogueFigureInput): { figure: PeriodFigure, series: PeriodSeries } {
  const spec = METRICS[FIGURE_METRIC_ALIAS[o.metric] ?? o.metric]
  if (spec === undefined) throw new Error(`no catalogue entry for '${o.metric}'`)
  const series = readPeriodSeries(q, o)
  const figure = periodFigureOf({
    metric: o.metric, unit: spec.unit, precision: spec.precision, direction: spec.direction as FigureDirection,
    range: o.range, anchor: o.anchor, lastDay: o.lastDay, values: series.values, dailyBands: series.bands,
    per: o.per, additive: o.additive ?? spec.aggs[0] === 'sum',
  })
  return { figure, series }
}

export interface ValuesFigureInput {
  metric: string, unit: string, precision: number, direction: FigureDirection
  range: PeriodRange, anchor: string, bounds: DateSpan, lastDay: string
  values: ReadonlyMap<string, number>, per?: 'day' | 'week', additive: boolean
  /** Every day's band; by default banded in memory from `values`, as `baselines` would. */
  dailyBands?: ReadonlyMap<string, Baseline | null>
}

/** A figure over values computed from reads already made rather than read itself. */
export function valuesFigure(o: ValuesFigureInput): PeriodFigure {
  const { bounds, dailyBands, ...rest } = o
  return periodFigureOf({ ...rest, dailyBands: dailyBands ?? bandsOver(o.values, bounds, o.lastDay) })
}

/** A section without data hides; the server decides it, so the page never draws an empty figure. */
export const shown = (figure: PeriodFigure): boolean => figure.days > 0
export const orNull = (figure: PeriodFigure): PeriodFigure | null => (shown(figure) ? figure : null)

/** The period itself: its days, how many of them are finished (to `lastDay`), and whether it still runs. */
export function periodHeader(range: PeriodRange, bounds: DateSpan, today: string, lastDay: string): PeriodHeader {
  return {
    range, from: bounds.from, to: bounds.to, today,
    periodDays: daysIn(bounds), daysSoFar: daysIn({ from: bounds.from, to: lastDay }), partial: lastDay < bounds.to,
  }
}

/** The hero against the calendar period before and the same period a year earlier, from values already read. */
export function periodChanges(
  values: ReadonlyMap<string, number>, range: PeriodRange, anchor: string, bounds: DateSpan, current: number | null, lastDay: string,
): { previous: PeriodChange, yearEarlier: PeriodChange } {
  const previousBounds = periodBounds(range, stepPeriod(range, anchor, -1))
  const yearEarlierBounds = { from: yearEarlierDate(bounds.from), to: yearEarlierDate(bounds.to) }
  return {
    previous: changeOf(values, previousBounds, current, lastDay, 1),
    yearEarlier: changeOf(values, yearEarlierBounds, current, lastDay, 1),
  }
}
