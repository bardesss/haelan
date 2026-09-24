import type { ECElementEvent } from 'echarts'
import type { ChartTokens } from './tokens.js'
import type { Translate } from '../format.js'

export const STROKE = {
  sparkline: 1.6,
  series: 1.9,
  nightSpan: 5,
  // Hairline, because it is there to give the mark an edge the card cannot
  // swallow, not to be seen as a line in its own right.
  stageOutline: 1,
} as const

export const OPACITY = {
  rangeBand: 0.22,
  baselineBand: 0.5,
} as const

export const SYMBOL = {
  nap: 6,
  excluded: 7,
  noData: 3,
} as const

export const AXIS_FONT_SIZE = 12

/**
 * A day's verdict against its usual, as the server sends it (`GlanceStripDay.standing`). Defined
 * here rather than in Sparkline.tsx, the one caller that draws it as a dot, because dayTableRows
 * below reads it too and base.ts already sits under Sparkline.tsx in the import graph.
 */
export type PointStanding = 'within' | 'above' | 'below' | null

/**
 * Applies the reader's motion preference to a built option object.
 *
 * useChart re-runs setOption with notMerge on every theme change, so every chart on the page
 * animates again each time - and ECharts animates by default, which nothing here had ever turned
 * off. A stated system preference overrules whatever a chart asked for: it is a statement about
 * the reader, not a default for a chart to weigh against its own preferences.
 *
 * A plain function rather than something wired into chartBase, so the decision is testable
 * without a DOM; the one line that reads the media query lives in useChart.
 */
export function withMotionPreference<T extends object>(option: T, reducedMotion: boolean): T & { animation: boolean } {
  return { ...option, animation: !reducedMotion }
}

/**
 * The one separator every place that joins several annotations' own text into one string reads,
 * rather than four independent `', '` literals (this file's own `annotationsByDate` below, plus
 * Sparkline/ActivityHeatmap/HeartRateRange's own table row builders) that happened to agree.
 * Nothing checked that agreement before: each channel hardcoded and asserted against its own copy,
 * so a change to one could drift from the other three and every existing test would still pass,
 * checking only the channel it already knew about. `chart-marks.test.tsx`'s own
 * "same joined text on the canvas as the table" cases are what actually locks the property this
 * constant only makes convenient to keep; this alone would not catch a second literal reappearing.
 */
export const ANNOTATION_JOIN = ', '

/**
 * Collapses `annotations` to one entry per date, joining every text that shares a date with
 * `ANNOTATION_JOIN`, the same separator the accessible table already uses for the same purpose
 * (Sparkline/ActivityHeatmap/HeartRateRange's own table row builders, all three filter+join
 * rather than find() for exactly this reason).
 *
 * An override reason, a note and an event can all land on one date now that day level marks
 * merge with the per-metric ones, where before this task an override alone could not: overrides
 * are unique on (person, scope, targetKey), so a (metric, date) pair never carried more than one.
 * A chart drawing one markLine/markPoint entry per annotation, unchanged since before that was
 * possible, put every one of them at the same anchor: echarts 6 defaults a markLine label to
 * `position: 'end'` and a markPoint label to `position: 'inside'`, so more than one annotation on
 * a date drew as several overlapping, unreadable strings on one pixel rather than several marks.
 * Grouping here first, before a chart's own index/coord lookup runs, makes the canvas draw
 * exactly what the table already states about that date: once.
 *
 * Reached from `dayMarks` below rather than called directly by a chart now, so all three charts
 * group the same way. Sparkline used to pass its annotations through ungrouped, on the grounds
 * that its own markLine draws with `label: { show: false }` and so had no labels to overlap. That
 * is still true of the labels, and it is no longer the whole story: a mark is what a reader clicks
 * to reopen the panel, and one mark per annotation on a date meant several stacked click targets
 * standing for the same day.
 */
export function annotationsByDate(
  annotations: readonly { date: string; text: string }[],
): { date: string; text: string }[] {
  const byDate = new Map<string, string[]>()
  for (const a of annotations) {
    const texts = byDate.get(a.date) ?? []
    texts.push(a.text)
    byDate.set(a.date, texts)
  }
  return [...byDate].map(([date, texts]) => ({ date, text: texts.join(ANNOTATION_JOIN) }))
}

/** An excluded day drawn at its own plotted value: the point is still on the chart, and the mark
 *  sits on top of it. Only reachable while the write has landed and the re-derive has not, since an
 *  applied exclusion leaves no value here at all. */
export interface ValueMark { date: string; index: number; value: number }

/** A mark drawn at a day's position alone, spanning the plot, because that day has no value left
 *  to sit on. `text` is what the day says for itself; `excluded` is why there is nothing there. */
export interface DateMark { date: string; index: number; text: string; excluded: boolean }

/**
 * Both kinds of mark a value axis chart draws, in the order the chart hands them to echarts.
 *
 * Sparkline and HeartRateRange only. ActivityHeatmap assembles its own marks inline and does not
 * call `dayMarks` at all, because the split below does not apply to it: a heatmap cell is a
 * coordinate on two category axes rather than a height, so a day with nothing to report still has
 * a cell to mark and never has to move to a by-position mark.
 *
 * The order is the contract, not an incidental: a click on an overlay reports the overlay's own
 * `dataIndex`, which counts into these arrays and nothing else, so the chart's `build` maps over
 * exactly these arrays and its click handler indexes back into exactly these arrays. Building the
 * echarts entries from one list and the click lookup from a second list assembled the same way is
 * the drift this shape exists to make impossible.
 */
export interface DayMarks { atValue: ValueMark[]; atDate: DateMark[] }

/**
 * Which marks a chart draws for one metric's overrides and annotations, split by whether there is
 * still a value under them.
 *
 * This split is the whole point, and it is what the branch review found missing. An exclusion that
 * has actually applied leaves no value behind: deriveDay deletes the excluded metric's daily row,
 * `/series` then omits the day, and a mark anchored at that day's own y had nothing to anchor to,
 * so it was silently dropped. The mark drew only while `applied` was still false, which is exactly
 * the window in which the exclusion had NOT taken effect, and vanished the moment it did. So an
 * excluded day with no value moves to `atDate`, where it is drawn by position alone and needs no y
 * at all, and the reader sees a marked, explained gap instead of a day that quietly disappeared.
 *
 * `dates` must be dense over the range the reader asked for, not just the days that reported, or
 * an applied exclusion has no index to be drawn at either: `denseSeries` (useSeries.ts) is what
 * every caller builds them with. A date this chart is not drawing is dropped rather than placed,
 * the same membership rule the per chart lookups have carried since the two month positioning fix.
 *
 * `excludedText` is folded into an excluded gap's own text so the canvas says the same sentence
 * the accessible table's note cell does for that date, rather than two independently assembled
 * strings that happen to agree; chart-marks.test.tsx compares the two off one render.
 *
 * Exclusions and annotations, and no third group for corrections: `POST /overrides` is the only
 * writer of an override row in this project, and OverrideStore.validate refuses `correct` at every
 * scope but `sample`, so a day scoped correction cannot be created. A correcting mark here would
 * also have lied if one ever were: deriveDay consults only excludedMetrics, so the plotted value
 * would still be the uncorrected one and the mark would name a replacement the number beside it
 * does not have. A milestone that adds day level corrections has to change validate and deriveDay
 * first, both of which this file's callers already import.
 */
export function dayMarks(input: {
  dates: readonly string[]
  values: readonly (number | null | undefined)[]
  excluded: readonly string[]
  annotations: readonly { date: string; text: string }[]
  excludedText: string
}): DayMarks {
  const indexOf = new Map(input.dates.map((date, index) => [date, index]))
  const valueAt = (index: number): number | null => {
    const value = input.values[index]
    return typeof value === 'number' ? value : null
  }

  const atValue: ValueMark[] = []
  // Insertion ordered, so the leftover gaps appended below come out in a stable order rather than
  // whatever order a hash happens to give.
  const gaps = new Set<string>()
  for (const date of input.excluded) {
    const index = indexOf.get(date)
    if (index === undefined) continue
    const value = valueAt(index)
    if (value === null) gaps.add(date)
    else atValue.push({ date, index, value })
  }

  const atDate: DateMark[] = []
  for (const annotation of annotationsByDate(input.annotations)) {
    const index = indexOf.get(annotation.date)
    if (index === undefined) continue
    const excluded = gaps.delete(annotation.date)
    atDate.push({
      date: annotation.date,
      index,
      excluded,
      text: excluded ? [input.excludedText, annotation.text].filter(Boolean).join(ANNOTATION_JOIN) : annotation.text,
    })
  }
  // An excluded day whose override reason never reached `annotations`. Every override the store
  // writes carries a notNull reason, so the two arrays arrive together from overridesByMetric and
  // this is empty in the app; a chart is handed the two props independently, though, and a gap with
  // no line at all would be the one shape that reads as "no data" rather than "you excluded this".
  for (const date of gaps) {
    atDate.push({ date, index: indexOf.get(date)!, text: input.excludedText, excluded: true })
  }
  return { atValue, atDate }
}

/**
 * The date a click on one of a chart's own overlay marks names, or undefined for a click on
 * anything else (the series itself, or empty space, both of which are the caller's own to resolve).
 *
 * An overlay click reports its own `componentType` and a `dataIndex` counting into that overlay's
 * data array, never into the chart's categories, which is why this cannot be folded into the
 * series lookup. It used to return nothing at all for every overlay click, which was correct while
 * an excluded day was still a plotted point with a mark sitting on it: the click fell through to
 * the point underneath. Once the day is a gap there is no point underneath, and a reader who
 * clicked the mark on the day they excluded, to undo it, hit nothing.
 */
export function markClickDate(
  marks: DayMarks,
  event: { componentType?: string; dataIndex?: number },
): string | undefined {
  if (event.dataIndex === undefined) return undefined
  if (event.componentType === 'markPoint') return marks.atValue[event.dataIndex]?.date
  if (event.componentType === 'markLine') return marks.atDate[event.dataIndex]?.date
  return undefined
}

/**
 * Which local date a click on a day-indexed value chart landed on: a click on the series reads
 * `labels` by its own dataIndex, and a click on one of the overlay marks reads the mark it
 * actually hit (`markClickDate` above says why an overlay cannot be resolved against `labels`).
 * Undefined for a click that hit neither, which is empty space.
 *
 * An overlay click used to resolve to nothing at all. That was right while every mark sat on a
 * plotted point, since the click fell through to the point beneath it; an excluded day has no
 * point beneath it once the exclusion applies, and the mark is then the only thing there is to
 * click to undo it.
 *
 * A plain function, exported and tested on its own: echarts renders to an SVG this project's own
 * render environment cannot hit-test (see chart-marks.test.tsx's own note), so the
 * translation from a click event to a date is the one piece of this behaviour a test can reach.
 *
 * Shared by Sparkline and DailyBars (was `sparklinePointDate`, local to Sparkline.tsx, until
 * DailyBars needed the identical logic): centralised here for the same reason `dayTooltip` was
 * renamed off `sparklineTooltip` before it, so a second caller does not mean a second copy to
 * keep in sync by hand.
 */
export function dayPointDate(
  labels: string[], marks: DayMarks, event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>,
): string | undefined {
  if (event.componentType !== 'series') return markClickDate(marks, event)
  return labels[event.dataIndex]
}

/**
 * The accessible table rows for a day-indexed value chart: one row per day, `[date, formatted
 * value, ...optional trend, note]`. Sparkline and DailyBars each built this by hand -- verbatim
 * but for the trend column and the `episodic` filter, neither of which DailyBars draws -- which
 * is the third time this branch has pulled a piece of Sparkline out to a shared function rather
 * than let a second, byte-identical copy sit beside it (`dayTooltip.ts` and `dayPointDate` above
 * are the other two).
 *
 * `episodic`, `trend` and `hasTrend` all default to off, which is every caller but Weight's
 * weight card: see Sparkline's own comments on these three props for what each means and why only
 * one metric on the whole dashboard needs them.
 */
export function dayTableRows(input: {
  values: readonly (number | null)[]
  labels: readonly string[]
  excluded: readonly string[]
  annotations: readonly { date: string; text: string }[]
  format: (value: number | null, absent: string) => string
  t: Translate
  episodic?: boolean
  trend?: readonly (number | null)[]
  hasTrend?: boolean
  /** A column for the same days a year earlier, when the reader is comparing (Sparkline). */
  lastYear?: readonly (number | null)[]
  // One verdict per entry of `values` (Sparkline's own dots): a day the server calls 'above' or
  // 'below' gets that said in words in the note cell, so a day out of band reads that way to a
  // screen reader too rather than only by the dot's colour. Undefined for every caller but
  // Sparkline's dashboard strips - see Sparkline's own `pointStandings` doc comment for why this
  // is never worked out here from `values` and a baseline.
  standings?: readonly PointStanding[]
}): (string | number)[][] {
  const { values, labels, excluded, annotations, format, t, episodic = false, trend, hasTrend = false, lastYear, standings } = input
  return values
    .map((v, i) => [v, i] as const)
    // Filtered before the map, not after: under episodic a SILENT day (no value, nothing the
    // reader did to it either) is not a row this table states anything about, so it is dropped
    // rather than rowed with a "no reading" cell the spec says would train a reader to ignore what
    // that phrase means on every other chart. An excluded or annotated day keeps its row even with
    // no value left, since the canvas still draws a markLine for it regardless of `episodic`.
    // `!episodic` short-circuits the other two clauses for every non-episodic caller.
    .filter(([v, i]) => {
      if (!episodic || v !== null) return true
      const date = labels[i] ?? String(i)
      return excluded.includes(date) || annotations.some((a) => a.date === date)
    })
    .map(([v, i]) => {
      const date = labels[i] ?? String(i)
      const isExcluded = excluded.includes(date)
      // "excluded", not "no reading", for a day the reader threw out: there was a reading, and the
      // day is blank because of something they did rather than because the device never reported.
      // "no reading" is the honest cell only for the second of those.
      const absent = t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading')
      const cell = format(v, absent)
      return [date, cell, ...(hasTrend ? [format(trend?.[i] ?? null, absent)] : []),
        ...(lastYear !== undefined ? [format(lastYear[i] ?? null, t('charts.absence.noReading'))] : []),
        [standings?.[i] === 'above' ? t('charts.standing.above') : standings?.[i] === 'below' ? t('charts.standing.below') : '',
          isExcluded ? t('charts.absence.excluded') : '',
          // filter, not find: several annotations can land on the same date now that day level
          // marks join the per-metric ones, and a single find() here would silently show only the
          // first and drop the rest. ANNOTATION_JOIN, not a second ', ' literal: annotationsByDate
          // above reads the same constant, so a table cell and a canvas label built from the same
          // annotations array cannot drift apart on separator alone.
          annotations.filter((a) => a.date === date).map((a) => a.text).join(ANNOTATION_JOIN)]
          .filter(Boolean).join(ANNOTATION_JOIN)]
    })
}

type Inset = { left?: number; right?: number; top?: number; bottom?: number }

export function chartBase(t: ChartTokens) {
  const axisLabel = { color: t.axis, fontSize: AXIS_FONT_SIZE }
  return {
    axisLabel,
    // Gridlines and axis lines share a colour deliberately; at 1.04:1 in the dark theme they are structure, not a mark to read a value off.
    splitLine: { lineStyle: { color: t.grid } },
    axisLine: { lineStyle: { color: t.grid } },
    hiddenAxis: { axisLine: { show: false }, axisTick: { show: false } },
    tooltip: { backgroundColor: t.tooltipBg, borderColor: t.grid, textStyle: { color: t.muted } },
    grid: (inset: Inset = {}) => ({ left: 34, right: 12, top: 12, bottom: 24, ...inset }),
    labelledAxis: { axisLabel, axisLine: { lineStyle: { color: t.grid } } },
  }
}

/**
 * The one place this project turns text into tooltip HTML.
 *
 * Every chart tooltip on the dashboard is assembled as an HTML string, because that is what
 * echarts renders a `tooltip.formatter` return value as: it writes the string into the tooltip
 * element with innerHTML, tags and all. Nothing upstream of that call stops markup getting in.
 * i18next is configured with `interpolation: { escapeValue: false }` (i18n/index.tsx), which is
 * the right setting for an app whose other output goes through React, and it means a `t()` result
 * carries its interpolated values exactly as given. So an annotation a member of the household
 * typed -- an override reason, a note, an event -- and a source's own alias both reached these
 * formatters raw, and a note reading `<img src=x onerror=...>` was not text on hover, it was a
 * tag the browser built and a handler the browser ran.
 *
 * The asymmetry is what made this worth its own pass rather than a shrug. The accessible table
 * beside every one of these charts states the same annotation text through React, which escapes
 * it; the chart-styling document treats the two channels saying the same thing about the same day
 * as binding. Before this helper they disagreed about what the text even was.
 *
 * A tagged template rather than an `escapeHtml(...)` call at each interpolation, and that choice
 * is the substance of the fix. Wrapping each value by hand keeps the formatters correct only for
 * as long as everyone remembers to wrap, which is the "two implementations kept in agreement by
 * habit" shape `ANNOTATION_JOIN` above exists to reject. Here the literal parts of the template
 * are the formatter's own structure (`<br/>` and nothing else, in every caller) and every `${}`
 * is text, so the default is safe and a new formatter written the obvious way inherits it. A
 * value that is somehow NOT text can only come out over-escaped, which is a visible cosmetic bug
 * rather than a silent hole: this fails safe in the one direction that matters.
 */
export function escapeHtml(text: string): string {
  // `&` is in the same pass as the other two, not a separate `.replace` before them: replacing it
  // first and the angle brackets afterwards would re-enter the `&` it had just written and turn
  // `<` into `&amp;lt;`. One regex with one replacer visits each character exactly once.
  //
  // Quotes are deliberately not in this set. A formatter's output is element CONTENT -- echarts
  // assigns it to the tooltip element's innerHTML -- never an attribute value, and inside content
  // a quote is an ordinary character with nothing to break out of. Leaving them alone is also
  // what makes these tooltips character-for-character identical to the DOM's own serialisation of
  // the table cell beside them, so the two channels agree on the text without either having to
  // know how the other escapes.
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/**
 * Builds a tooltip's HTML, escaping every interpolated value and leaving the template's own
 * literal markup (the `<br/>` separators these formatters are built out of) alone. See
 * `escapeHtml` above for why this is a tagged template rather than a helper called per value.
 *
 * Nesting: a value that is itself a `tip` result would be escaped a second time, so a formatter
 * assembling several already-built lines joins them with a plain `.join('<br/><br/>')` instead of
 * feeding them back through here. IntradayHeartRate is the one caller that does this.
 */
export function tip(parts: TemplateStringsArray, ...values: unknown[]): string {
  return parts.reduce(
    (out, part, i) => out + part + (i < values.length ? escapeHtml(String(values[i])) : ''),
    '',
  )
}
