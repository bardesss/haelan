import type { ChartTokens } from './tokens.js'

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
