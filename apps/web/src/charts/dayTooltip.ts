import type { ECElementEvent } from 'echarts'
import { escapeHtml, tip } from './base.js'
import type { DayMarks } from './base.js'
import type { Translate } from '../format.js'

/**
 * Everything the tooltip reads, handed in rather than closed over, so this stays a pure function a
 * test can reach: echarts renders to an SVG this project's render environment cannot hit-test
 * (chart-marks.test.tsx's own note), which makes the translation from an event to a string the one
 * piece of this behaviour a test can exercise at all. `dayPointDate` in base.ts is exported for
 * exactly the same reason and this follows it.
 */
export interface DayTooltipInput {
  /** Dense over the range, one entry per calendar day, null where nothing was reported. */
  values: readonly (number | null)[]
  /** The local dates `values` are indexed by. The x axis carries array positions, not dates. */
  labels: readonly string[]
  excluded: readonly string[]
  annotations: readonly { date: string; text: string }[]
  marks: DayMarks
  trend: readonly (number | null)[] | undefined
  hasTrend: boolean
  /** The same days a year earlier, when the reader is comparing; undefined otherwise. */
  lastYear?: readonly (number | null)[]
  episodic: boolean
  /** The accessible table's own value-column header, reused verbatim as the tooltip's label. */
  unit: string
  /**
   * Already resolved by the caller to `formatValue` or the `formatMetricValue` default, so the
   * canvas and the table cannot disagree about a unit: Activity's distance plots millimetres and
   * displays kilometres, Weight's card plots grams and displays kilograms, and a tooltip going
   * through the catalogue default for either prints a number in a unit nothing on the card names.
   */
  format: (value: number | null, absent: string) => string
  t: Translate
}

/**
 * The tooltip for a day's readout or overlay mark, as the HTML string echarts' formatter returns.
 *
 * A mark's own `tooltip.trigger` defaults to `'item'` (MarkPointModel/MarkLineModel both set it in
 * their own defaultOption) and overrides the chart's `'axis'` trigger, so a hover on a mark reaches
 * here with a `dataIndex` counting into that mark's own array - `marks.atValue` or `marks.atDate` -
 * and never into `values`. Indexing `values` on that number names whichever day happens to sit at
 * that small index, wrong for every mark not itself drawn on the day at that position. Resolving
 * through `marks` first, the same list `build` drew the marks from, is what keeps the two from
 * disagreeing; HeartRateRange.tsx carries the same branch for the same reason.
 */
export function dayTooltip(
  input: DayTooltipInput,
  event: Pick<ECElementEvent, 'componentType'> & { dataIndex?: number },
): string {
  const { marks, labels, values, excluded, annotations, trend, hasTrend, lastYear, episodic, unit, format, t } = input
  const index = event.dataIndex

  if (event.componentType === 'markPoint') {
    const mark = index === undefined ? undefined : marks.atValue[index]
    return mark ? tip`${mark.date}<br/>${t('charts.absence.excluded')}` : ''
  }
  if (event.componentType === 'markLine') {
    const mark = index === undefined ? undefined : marks.atDate[index]
    // `text` already has the excluded word folded in by dayMarks, so the canvas says the same
    // sentence the table's note cell does. Adding the word again here would say it twice.
    //
    // This is the line the escaping exists for. `mark.text` is what a member of the household
    // typed -- an override reason, a note, an event -- and echarts writes a formatter's return
    // value into the tooltip element with innerHTML. Before `tip`, a note reading
    // `<img src=x onerror=...>` was not text on hover, it was a tag the browser built.
    return mark ? tip`${mark.date}<br/>${mark.text}` : ''
  }

  const date = index === undefined ? undefined : labels[index]
  if (date === undefined || index === undefined) return ''
  const value = values[index] ?? null
  const isExcluded = excluded.includes(date)

  // The same predicate the accessible table filters its rows by, not a second one assembled the
  // same way: under `episodic` a silent day is not a day this chart states anything about, but a
  // day the reader excluded or annotated keeps its row, and so keeps its readout.
  if (episodic && value === null && !isExcluded && !annotations.some((a) => a.date === date)) return ''

  // "excluded", not "no reading", for a day the reader threw out: there was a reading, and the day
  // is blank because of something they did rather than because the device never reported.
  const absent = t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading')
  const lines = dayTooltipLines(date, unit, format(value, absent), t)
  if (hasTrend) {
    // The same column name the table gives the trend, so the two channels cannot drift apart on
    // wording, and the same formatter, since a trend is a smoothed reading in the identical unit.
    lines.push(t('charts.tooltip.line', {
      label: t('charts.columns.trend'), value: format(trend?.[index] ?? null, absent),
    }))
  }
  if (lastYear !== undefined) {
    // "no reading" whatever this year's day holds: an exclusion is something the reader did to
    // this year's day, and says nothing about the same date a year earlier.
    lines.push(t('charts.tooltip.line', {
      label: t('charts.columns.lastYear'), value: format(lastYear[index] ?? null, t('charts.absence.noReading')),
    }))
  }
  // Each part escaped, then joined plainly, rather than assembled in one `tip` template: the
  // number of lines varies with `hasTrend`, so there is no fixed template to tag. Same shape
  // IntradayHeartRate uses for its own variable-length assembly, and the reason `tip`'s own doc
  // comment gives for not feeding an already-built line back through it.
  //
  // `format` is the caller's own formatter here, so a metric whose display unit is produced
  // outside this file still arrives as text rather than as markup.
  return lines.map(escapeHtml).join('<br/>')
}

/**
 * The two lines every day's tooltip opens with, as plain text: the day, then "Label: value".
 * dayTooltip escapes and joins them for echarts; the dashboard's week bars (WeekBars.tsx), which
 * are not an echarts chart, render the same lines through React, so a bar and a strip dot for the
 * same day say the same thing in the same order.
 */
export function dayTooltipLines(date: string, label: string, value: string, t: Translate): string[] {
  return [date, t('charts.tooltip.line', { label, value })]
}
