import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams, ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, dayMarks, dayPointDate, dayTableRows, escapeHtml, AXIS_FONT_SIZE, STROKE, OPACITY, SYMBOL } from './base.js'
import type { PointStanding } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatLocalDate, formatMetricValue } from '../format.js'
import { dayTooltip } from './dayTooltip.js'
import type { DayTooltipInput } from './dayTooltip.js'

// A stable reference for a caller that omits annotations/excluded, the same device Dashboard.tsx's
// own EMPTY constant uses: a default parameter expression that is a fresh `[]` literal runs on
// every call, handing `build`'s useCallback a new array identity on every render regardless of
// what actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// The dashboard's day dots (`dots` below): the latest day larger than the rest, both sizes in
// pixels as echarts takes them, and the latest dot's rim in the card's own colour so it reads as
// lifted off the line rather than sitting on it.
const DOT = { day: 6, latest: 11, rim: 2 } as const

// The gap, in pixels, between the band label's own right edge and the plot area it sits left of
// (`grid.left` below is set to the label's own width plus this): with none, a label right at the
// axis label font size would still touch the first day's dot or line the moment its own width was
// measured exactly, since "just fits" and "touches" are the same pixel.
const BAND_LABEL_GAP = 8
// Same font stack packages/tokens/src/primitives.ts's `font.sans` emits as `--font-sans`, read
// straight off the document when one exists (measureLabelWidth below) rather than imported from
// tokens: a chart has no CSS import of its own, and hardcoding the one property this needs is
// cheaper than adding a dependency on the whole tokens package for a single string.
const FONT_FAMILY_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

// The one family string both measureLabelWidth (below) and the band-high/band-low markPoint labels
// themselves resolve to, so they cannot drift apart: zrender (echarts' own renderer) paints a label
// with no `fontFamily` of its own in a generic 'sans-serif', which is a different typeface with
// different glyph widths from the app's own --font-sans stack (Segoe UI vs Arial on Windows, for
// one). Measuring against one family while painting in another would size `grid.left` correctly
// for a font nothing on screen is actually set in - a review caught exactly that gap. Read straight
// off the document when one exists rather than imported from tokens: a chart has no CSS import of
// its own, and hardcoding the one property this needs is cheaper than adding a dependency on the
// whole tokens package for a single string.
function labelFontFamily(): string {
  const fromDocument = typeof document !== 'undefined' && typeof getComputedStyle === 'function'
    ? getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()
    : ''
  return fromDocument || FONT_FAMILY_FALLBACK
}

// Used only when no canvas 2D context is available to measure with (happy-dom in tests, and any
// other environment without a real canvas): an average character width at the axis label's own
// font size, wide enough that a fallback estimate never comes in narrower than the real text would
// measure, which would be the one way this margin could still clip.
const FALLBACK_CHAR_WIDTH = 7.5

// The band label's own pixel width at `fontSize`, so `grid.left` below can fit it exactly instead
// of guessing a fixed margin: bandLabels carries whatever formatMetricValue or a caller's own
// formatter produced ("11.590", "7h 48m"), and those differ in width by more than a fixed 40px
// margin could cover for every metric and every locale. A real canvas 2D context measures the
// actual glyphs in the same family (labelFontFamily above) the label itself is painted in; without
// one (happy-dom in tests, or any environment with no canvas support) the fallback above stands in,
// wide enough that a test asserting against it can still pin "grows with a longer label" without
// touching a canvas at all.
function measureLabelWidth(text: string, fontSize: number): number {
  if (typeof document === 'undefined') return text.length * FALLBACK_CHAR_WIDTH
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return text.length * FALLBACK_CHAR_WIDTH
  ctx.font = `${fontSize}px ${labelFontFamily()}`
  return ctx.measureText(text).width
}

// One day's step of the per-day band (`bands`): its whole category slot, centre +/- half a slot,
// from its own low to its own high. Each edge is rounded to a whole pixel from the shared boundary
// value, so two neighbouring steps meet on exactly the same pixel column: no seam of doubled
// shading where they would overlap, and no hairline gap where they would not quite touch.
export function bandStep(tokens: ChartTokens) {
  return (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
    const day = Number(api.value(0))
    const [x = 0, yLow = 0] = api.coord([day, Number(api.value(1))])
    const [, yHigh = 0] = api.coord([day, Number(api.value(2))])
    // api.size() is typed number | number[] for other coord systems; a category/value grid always
    // returns [x, y], x being one category's slot width (Hypnogram reads it the same way).
    const size = api.size?.([1, 0]) ?? 0
    const half = (Array.isArray(size) ? size[0] ?? 0 : size) / 2
    const left = Math.round(x - half)
    const right = Math.round(x + half)
    return { type: 'rect' as const, shape: { x: left, y: yHigh, width: right - left, height: yLow - yHigh },
      style: { fill: tokens.band, opacity: OPACITY.baselineBand } }
  }
}

// Re-exported from base.ts (defined there so dayTableRows can read it too) rather than defined
// here a second time: every existing caller imports `PointStanding` from this module.
export type { PointStanding } from './base.js'

// No grid or ticks: a sparkline is a shape, not a chart to consult; the table carries the numbers it stands in for.
export function Sparkline({
  values, labels, label, unit, metric, formatValue, baseline, bandLabels, height = 34, annotations = EMPTY, excluded = EMPTY,
  onPointClick, episodic = false, trend, lastYear, tableToggle = true, dots = false, pointStandings = EMPTY, opensDay, bands,
}: {
  // Dense over the range the reader asked for, one entry per calendar day, with null where nothing
  // was reported: denseSeries (useSeries.ts) is what every caller builds them with, and its own
  // comment says why a points array straight off /series is not enough. A day with no position on
  // this axis cannot be marked, and an applied exclusion is exactly a day /series stops answering
  // for, so a sparse pair here silently loses the mark, the reason and the table row for the one
  // day the reader acted on.
  values: (number | null)[]
  labels: string[]
  label: string
  // The accessible table's second column header (already-translated display text, e.g. "steps"),
  // not a unit code: kept separate from `metric` below because a header string and a catalogue
  // lookup key answer two different questions and every caller already had the former on hand.
  unit: string
  // Every value in `values` is presumed to already be in METRICS[metric]'s own stored unit (see
  // formatMetricValue's doc comment in format.ts): the CHART never converts, since its y axis is
  // hidden (`show: false` below) and a linear rescale draws an identical shape regardless of unit.
  // The accessible TABLE is a different question, answered by `formatValue` below: this `metric`
  // prop alone drives the table's default formatting (`formatMetricValue(v, metric, ...)`), which
  // is right for every caller except one whose displayed unit differs from the stored one.
  //
  // Activity.tsx's own distance card used to be cited right here as proof no caller ever needed
  // that: an M3e review caught that it was not proof of correctness but the defect itself. Its
  // Sparkline plots the same per-day millimeter values as every other metric (harmless, per the
  // paragraph above), but its accessible table cell read those same raw millimeters
  // ("5,234,567") beside a column header translated as "Distance in kilometers" -- a sighted
  // reader saw a hand-converted "5.2 km" headline while a screen reader was handed a number seven
  // digits longer, under a header naming a unit that number was never in. `formatValue` below
  // exists so that one caller can override the table cell's own formatter without asking this
  // prop itself to claim a unit conversion the catalogue cannot answer for it.
  metric: string
  // Overrides the accessible table's own value-cell formatter (default: `formatMetricValue(v,
  // metric, language, absent)`), for the one shape formatMetricValue can never be handed safely:
  // a value already converted out of METRICS[metric]'s stored unit (format.ts's own comment on
  // formatNumber explains why formatMetricValue has no parameter for this). `values` above stay in
  // the stored unit regardless (the chart's own y axis is hidden, so nothing there needs a
  // conversion); this formatter runs per row against the same raw values, so it takes and converts
  // one value itself rather than being handed an already-converted array.
  formatValue?: (value: number | null, absent: string) => string
  // Optional and, when present, never thin: the same rule HeartRateRange's own `baseline` prop
  // documents. A band this project cannot stand behind reads as more authoritative than one built
  // from thirty real days, not less, so the caller (Recovery.tsx) only ever hands this over once
  // its own baseline query has cleared the thin check.
  baseline?: { low: number, high: number }
  // Text for the band's own low and high, anchored at the band's edges on the chart's left side
  // (day zero), away from the latest dot at the right end so the low label is never misread as
  // today's own value. Undefined (the default, every caller before NightCard) draws the band
  // exactly as it always has: shaded, and unlabelled everywhere but the accessible table, which
  // already prints the baseline in words through usualLine. Ignored with no `baseline` to anchor
  // against.
  bandLabels?: { low: string, high: string }
  height?: number
  // Same prop names and shapes HeartRateRange has taken since D1, so a page hands every chart type
  // the same annotations/excluded values instead of building a different shape per chart. Optional
  // here (HeartRateRange's own pair is required) because Sparkline's own default parameter (EMPTY,
  // below) has to exist regardless: a page can still mount a card before its overrides query has
  // answered.
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  onPointClick?: (localDate: string) => void
  // Dense over the same `labels` axis as `values`, one entry per calendar day with null where the
  // trend has nothing to draw (packages/core/src/query/trend.ts's trendOf only emits a point for a
  // day carrying a real reading, so a day between two sparse readings is null here exactly as it is
  // in `values`). Undefined for every caller but Weight's weight card: PersonQuery.trend was
  // specced and built for that one card and had no consumer until this prop.
  //
  // Drawn as a second series rather than folded into `values`, and drawn UNDER it (first in the
  // `series` array below, so echarts paints it before the reading series and the readings land on
  // top): the smoothed line is a reading of the series, not the series itself, and Weight's own 130
  // readings across 236 days is exactly the sparse history a smooth line over would look identical
  // for a dense month and a sparse one if it replaced the readings instead of sitting under them.
  trend?: (number | null)[]
  // The same days a year earlier (data/lastYear.ts), dense over the same labels, with null for a
  // day that had no reading then and for a leap day, which has no partner. Drawn first and dashed
  // in the muted tone, so this year's line sits on top and reads as the news; undefined while the
  // reader has the comparison off, which leaves the chart exactly as it was.
  lastYear?: (number | null)[]
  // False everywhere but Weight: default false is what keeps every chart already on a page reading
  // exactly as it did before this prop existed. A metric taken by hand (weight: 130 readings across
  // 236 days) has no data quality problem on a day nobody weighed in, unlike Activity, Sleep or
  // Recovery, so this mode connects the line across the gap instead of breaking it and drops a
  // silent day (no value, not excluded, not annotated) from the accessible table rather than
  // rowing it as "no reading". A day the reader excluded or annotated keeps its row regardless: the
  // canvas still draws a markLine for it (the `marks.atDate` block below is untouched by this
  // prop), and a row-less table beside a mark that keeps asserting something would deny the one day
  // the reader actually acted on, table-only readers included.
  episodic?: boolean
  // False drops the visible "show numbers" control under the strip and keeps the table for a
  // screen reader (ChartFigure's own prop of the same name). Only the dashboard's strips pass it.
  tableToggle?: boolean
  // A dot on every day with a value, the latest one larger and in the primary text colour. Off
  // (the default, every caller but the dashboard's three strips) draws the plain line it always has.
  dots?: boolean
  // One verdict per entry of `values`, from the server (GlanceStripDay.standing): a dot whose day
  // is 'above' or 'below' takes the warning colour. Read, never worked out here: comparing a value
  // against `baseline` in the client would be a second rule for the same verdict, and the server's
  // own already knows what the client cannot (a thin band, a day still running). Ignored without
  // `dots`; a missing entry is no verdict.
  pointStandings?: readonly PointStanding[]
  // The dashboard's strips (M9c), where a click on a dot opens that day rather than annotating it.
  // `current` is the day already on screen: it opens nothing, so a click on it does nothing, a tap
  // on a phone does not select it, and its tooltip does not offer it. Every other day with a value
  // ends its tooltip with `tail` ("Open this day"); `idle` and `named` word the phone's tap control
  // (ChartFigure) for opening instead of annotating. Undefined, every other caller, leaves the
  // tooltip exactly as dayTooltip writes it and the tap control on its annotate words.
  opensDay?: { current: string, tail: string, idle: string, named: (name: string) => string }
  // One usual per entry of `values`, each day's own (GlanceStripDay.band, never thin here), drawn
  // in place of `baseline`'s single band as a step per day: each day's slot shaded from its own low
  // to its own high, so the band a dot sits in is the band its colour was judged against. Steps
  // rather than a smooth polygon through the days' edges, because a polygon blends each day's band
  // into its neighbours' across the slot and a dot near an edge could then sit visibly inside the
  // shading while its verdict says outside. A null entry leaves that day's slot unshaded. `baseline`
  // is still what `bandLabels` label (the day shown, the last step), and still widens the y axis.
  // Undefined, every caller but the dashboard's day strips, draws `baseline` exactly as before.
  bands?: readonly ({ low: number, high: number } | null)[]
}) {
  const { t, i18n } = useTranslation()

  // Memoised, and read by both `build` and `onClick`: `build` maps over these arrays to produce the
  // echarts entries, and a click on one of those entries indexes straight back into them, so the
  // two cannot disagree about which mark is which. Memoised for the reason `EMPTY` above exists as
  // well, since a fresh object here every render would rebuild `build` and dispose the chart.
  const marks = useMemo(() => dayMarks({
    dates: labels, values, excluded, annotations, excludedText: t('charts.absence.excluded'),
  }), [labels, values, excluded, annotations, t])

  // Whether there is a trend to draw, not merely whether a caller passed the prop. `trend` is a
  // dense array built from a query, so it is defined and all-null in three ordinary states: while
  // /trend is still in flight, after it failed, and when trendOf legitimately emitted nothing
  // because the range holds fewer than TREND_MIN_POINTS readings (packages/core/src/query/trend.ts).
  // Branching on `trend !== undefined` treated all three as "a trend line is on the chart" and
  // switched the readings to bare symbols with their own line hidden, so a two reading range, or a
  // /trend that 500ed, drew two disconnected dots under a smooth line that was never painted, with
  // nothing on the card saying why. With nothing to draw, this chart is exactly the chart every
  // other Sparkline caller gets.
  const hasTrend = trend !== undefined && trend.some((v) => v !== null)
  // Drawn only when a year earlier holds something; the tile says so in words when it holds nothing.
  const comparing = lastYear !== undefined && lastYear.some((v) => v !== null)

  // One formatter, read by the canvas's tooltip and by every table row, rather than two built the
  // same way: `formatValue` is the override for a caller whose displayed unit differs from the
  // stored one (Activity's millimetres shown as kilometres, Weight's grams as kilograms), and a
  // tooltip that took the catalogue default while the table took the override would print two
  // different numbers for one day.
  const format = (value: number | null, absent: string): string =>
    formatValue ? formatValue(value, absent) : formatMetricValue(value, metric, i18n.language, absent)

  // A ref, not `build` dependencies, and for the reason useChart's own pointRef exists: the
  // tooltip reads `formatValue`, `t` and the language, and `formatValue` is a fresh arrow on every
  // render at two call sites (Activity.tsx's distance card, Weight.tsx's weight card). In `build`'s
  // dependency array those would dispose and re-initialise the chart on every render, which is the
  // exact defect chart-lifecycle.test.tsx guards. The formatter runs on hover, long after the
  // option was set, so reading the ref at that moment hands it the current values anyway.
  const tooltipRef = useRef<DayTooltipInput | null>(null)
  const opensRef = useRef(opensDay)
  useLayoutEffect(() => {
    tooltipRef.current = {
      values, labels, excluded, annotations, marks, trend, hasTrend, episodic, unit, format, t, lastYear: comparing ? lastYear : undefined,
    }
    opensRef.current = opensDay
  })

  // The last day with a value, which is the dot drawn large: "latest" is the newest reading on the
  // strip, so a strip whose final day has nothing yet still highlights the day that does.
  const latest = values.reduce<number>((found, v, i) => (v === null ? found : i), -1)

  // Memoised on the label strings themselves, not recomputed every time `build` is (build also
  // rebuilds for reasons that have nothing to do with the band, e.g. a new `values` array): the
  // wider of the two, since one grid margin has to fit both. Round 1 of this fix used a flat 40px
  // margin, which a label like "11.590" or "7h 48m" (past 40px at the axis label font size) simply
  // overran, running the text straight into the first day's own dot and line - measuring the real
  // text is the only way this stays correct across every metric's own formatting and every locale.
  // Zero without `baseline` as well as without `bandLabels`: the markPoint data below only ever
  // draws these two labels when both are set (`bandLabels && baseline`), so computing a margin for
  // `bandLabels` alone would widen the grid for text nothing on the chart actually draws.
  const bandLabelMargin = useMemo(() => {
    if (!bandLabels || !baseline) return 0
    const width = Math.max(
      measureLabelWidth(bandLabels.low, AXIS_FONT_SIZE),
      measureLabelWidth(bandLabels.high, AXIS_FONT_SIZE),
    )
    return Math.ceil(width) + BAND_LABEL_GAP
  }, [bandLabels, baseline])

  const build = useCallback((tokens: ChartTokens): EChartsOption => ({
    // Room on the left for the band's own edge labels, anchored at the first day so the low label
    // never sits beside today's (latest) dot at the right end, where a reader would misread it as
    // today's own value. Sized to the label text itself (bandLabelMargin above) rather than a flat
    // number, so the gap is always exactly wide enough and never wider than it needs to be. Only
    // when both `bandLabels` and `baseline` are set - the same condition the markPoint data below
    // draws these two labels under - since bandLabelMargin is 0 for `bandLabels` alone (no baseline
    // to anchor the labels against) and `bandLabels ? bandLabelMargin : ...` would then wrongly
    // drop this margin to 0 instead of falling back to the plain non-label margin below. With dots,
    // a margin of half the latest dot on every other side, so a day at the strip's edge or its
    // extreme is drawn whole rather than clipped by the grid.
    grid: dots
      ? { left: bandLabels && baseline ? bandLabelMargin : DOT.latest / 2, right: DOT.latest / 2, top: DOT.latest / 2, bottom: DOT.latest / 2 }
      : { left: bandLabels && baseline ? bandLabelMargin : 0, right: 0, top: 4, bottom: 4 },
    tooltip: {
      ...chartBase(tokens).tooltip,
      trigger: 'axis' as const,
      // Every input arrives through the ref rather than through this closure, so nothing here
      // widens `build`'s dependency array; see tooltipRef above for why that matters.
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : params
        const current = tooltipRef.current
        if (!p || !current) return ''
        const event = p as Parameters<typeof dayTooltip>[1]
        const html = dayTooltip(current, event)
        // A day's own readout only, never a mark's (whose dataIndex counts into the marks), and
        // only a day with a value: the day is what a click on this point would open.
        const opens = opensRef.current
        const date = event.componentType === 'series' && event.dataIndex !== undefined ? current.labels[event.dataIndex] : undefined
        const openable = opens !== undefined && html !== '' && date !== undefined && date !== opens.current
          && current.values[event.dataIndex!] != null
        // Joined, not templated: `html` is already escaped markup, which `tip` would escape again.
        return openable ? [html, escapeHtml(opens.tail)].join('<br/>') : html
      },
    },
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    // scale: true fits the axis to the series values alone; a markArea/markPoint never widens that
    // extent, so a band whose edge sits outside every day's own value (steps strip: every day below
    // the band's top) got silently clipped along with its edge label. With a baseline to draw,
    // widen the fitted extent to include both band edges (echarts calls min/max with the extent it
    // would otherwise have picked); with no baseline, `scale: true` alone behaves exactly as before.
    yAxis: { type: 'value' as const, show: false, scale: true,
      ...(baseline && {
        min: (extent: { min: number }) => Math.min(extent.min, baseline.low),
        max: (extent: { max: number }) => Math.max(extent.max, baseline.high),
      }) },
    series: [
      ...(comparing ? [{ type: 'line' as const, data: lastYear, showSymbol: false, connectNulls: episodic, silent: true,
        lineStyle: { width: STROKE.sparkline, color: tokens.muted, type: 'dashed' as const } }] : []),
      // Under the reading series below (drawn first, so echarts paints it first and the readings
      // land on top of it): trend's own dense array is null everywhere trendOf had no reading to
      // smooth, and connectNulls is unconditionally true here regardless of `episodic`, since a
      // smooth line spanning the gaps between sparse readings is the entire reason this series
      // exists, not a fact about whether the metric is taken by hand.
      ...(hasTrend ? [{ type: 'line' as const, data: trend, showSymbol: false, smooth: true,
        connectNulls: true, lineStyle: { width: STROKE.sparkline, color: tokens.seriesAlt } }] : []),
      { type: 'line' as const,
        data: dots
          ? values.map((v, i) => {
            if (v === null) return null
            const standing = pointStandings[i] ?? null
            const out = standing === 'above' || standing === 'below'
            const isLatest = i === latest
            return { value: v, symbolSize: isLatest ? DOT.latest : DOT.day,
              itemStyle: { color: out ? tokens.negative : isLatest ? tokens.primary : tokens.series,
                borderColor: tokens.surface, borderWidth: isLatest ? DOT.rim : 0 } }
          })
          : values,
        // A trend line already supplies the connecting line once one is drawn, so the reading
        // series switches from a line to bare points: showSymbol true draws a marker at every
        // reading, and lineStyle opacity 0 (the same idiom IntradayHeartRate uses to hide a
        // stacking helper series) keeps its own jagged line from also being drawn under the smooth
        // one. Unchanged (a plain connected line, no symbols) when there is no trend line to draw,
        // which is every caller but Weight's weight card and, on that card, every range whose own
        // trend query has not answered with a real point (see hasTrend above).
        showSymbol: hasTrend || dots, ...(dots && { symbol: 'circle' }), connectNulls: episodic,
        lineStyle: { width: STROKE.sparkline, color: tokens.series, ...(hasTrend && { opacity: 0 }) },
        // Same markArea shape HeartRateRange draws its band with: a rectangle between two y values,
        // unbounded on x, so it sits behind the line regardless of how many points there are.
        ...(baseline && !bands && { markArea: { silent: true, itemStyle: { color: tokens.band, opacity: OPACITY.baselineBand },
          data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] } }),
        markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
          // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands
          // off the fitted range; anchor at the day's own value instead, same as HeartRateRange.
          // dayMarks has already dropped a date this sparkline is not drawing and moved an excluded
          // day with no value left to `atDate`, where it is drawn by position instead of being
          // silently lost, so everything left here is a day whose number is still on the chart with
          // the mark sitting on top of it.
          //
          // The band's own low/high labels ride the same markPoint rather than a separate series or
          // a `graphic` element: `graphic` positions in pixels, with no way to ask for "the y a
          // value of 9,500 maps to" short of reading the chart instance back out after it renders,
          // where markPoint's xAxis/yAxis pair is a data coordinate echarts resolves against
          // whatever extent the axis actually fits, the same as every excluded mark below it. Each
          // is invisible (symbolSize 0) and anchored at day zero, the chart's LEFT edge, with its
          // own text as a label rather than a symbol, right-aligned back toward the band so it
          // reads next to the shading rather than off the strip's edge. Anchored at the first day
          // rather than the last: the right edge sits beside the latest dot (`dots`'s large, primary-
          // coloured point for today), where the low label in particular used to read as if it were
          // today's own value instead of the band's.
          data: [
            ...marks.atValue.map((mark) => ({ name: 'excluded', xAxis: mark.index, yAxis: mark.value })),
            // `distance` set explicitly to BAND_LABEL_GAP rather than left at echarts' own default
            // (5px): bandLabelMargin above reserves exactly textWidth + BAND_LABEL_GAP for this
            // label, so the label's own offset from its anchor has to agree with that reservation
            // or the two numbers drift apart the moment either one changes. `fontFamily` set to the
            // exact same string measureLabelWidth measured with (labelFontFamily above), for the
            // same reason: zrender paints a label with no fontFamily of its own in a generic
            // 'sans-serif', not the app's --font-sans, so the two would silently measure and paint
            // in different typefaces without this.
            ...(bandLabels && baseline ? [
              { name: 'band-high', xAxis: 0, yAxis: baseline.high, symbolSize: 0,
                label: { show: true, position: 'left' as const, distance: BAND_LABEL_GAP, color: tokens.muted,
                  fontSize: chartBase(tokens).axisLabel.fontSize, fontFamily: labelFontFamily(),
                  formatter: () => bandLabels.high } },
              { name: 'band-low', xAxis: 0, yAxis: baseline.low, symbolSize: 0,
                label: { show: true, position: 'left' as const, distance: BAND_LABEL_GAP, color: tokens.muted,
                  fontSize: chartBase(tokens).axisLabel.fontSize, fontFamily: labelFontFamily(),
                  formatter: () => bandLabels.low } },
            ] : []),
          ] },
        markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
          label: { show: false },
          // An excluded day with no value left overrides the dashed annotation styling with the
          // excluded colour and a solid line, so a gap the reader made reads apart from a day that
          // merely carries a note, in shape as well as in colour. No label either way: this chart is
          // 34 pixels tall and draws no text at all, so the reason lives in the accessible table
          // beside it and in the panel a click on this mark reopens.
          data: marks.atDate.map((mark) => ({ name: mark.text, xAxis: mark.index,
            ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })) } },
      // The per-day band (`bands`), last in the array so every index before it is what it always
      // was (the tooltip reads the first series' params and a click resolves the reading series'
      // own dataIndex), and at a lower z so it is painted beneath the line and the dots. Silent:
      // it is shading, never a point to hover or open.
      ...(bands ? [{ type: 'custom' as const, silent: true, z: 1, tooltip: { show: false },
        encode: { x: 0, y: [1, 2] },
        data: bands.flatMap((band, i) => (band === null ? [] : [[i, band.low, band.high]])),
        renderItem: bandStep(tokens) }] : []),
    ],
    // `labels` is in this list even though nothing above reads it, and it is not dead weight.
    // useChart keys its stale-tap reset on `build`'s identity, and the resolvers below (onClick,
    // describe) index into `labels` - so a `labels` that can change without `build` changing is a
    // stored tap replayed against data the chart no longer draws, the exact defect 75878d3 exists
    // to prevent. That never happened only because denseSeries (data/useSeries.ts) returns
    // `labels` and `values` from one call, so their identities move together, and because `marks`
    // is memoised over `labels` as well; both are facts about today's call sites, not about this
    // component. Memoise `labels` separately anywhere and the bug returns with every test green.
    // Listing it makes the safety this chart's own, at no cost: `marks` already changes with it.
  }), [values, labels, baseline, bandLabels, bandLabelMargin, marks, episodic, trend, hasTrend, comparing, lastYear, dots, pointStandings, latest, bands])

  // The day already shown is not a point to act on when this strip opens days (`opensDay`).
  const current = opensDay?.current
  const onClick = useCallback((event: ECElementEvent) => {
    const date = dayPointDate(labels, marks, event)
    if (date !== undefined && date !== current) onPointClick?.(date)
  }, [labels, marks, onPointClick, current])

  // The same resolver as onClick, so the annotate control below the breakpoint names exactly the
  // point a click would have opened. This chart draws no axis labels at all, so the formatted date
  // is the only place the tapped day is ever written down outside the tooltip.
  const describe = useCallback((event: ECElementEvent) => {
    const date = dayPointDate(labels, marks, event)
    return date === undefined || date === current ? undefined : formatLocalDate(date, i18n.language)
  }, [labels, marks, i18n.language, current])

  // Conditional on the caller having somewhere to send a click, not unconditional: `onClick`
  // above bottoms out in `onPointClick?.(...)`, so handing useChart a pair it can never act on
  // renders an annotate control that names a point and then does nothing when pressed. See
  // useChart's ChartPointHandlers doc comment; chart-annotate-handlers.test.tsx pins it.
  const { host, style, tap } = useChart(build, height, onPointClick ? { onClick, describe } : undefined)
  return (
    <>
      <ChartFigure label={label} host={host} style={style} tap={tap} tableToggle={tableToggle}
        tapWords={opensDay && { idle: opensDay.idle, named: opensDay.named }}
        table={{
          // The trend gets a column of its own whenever it is drawn, between the reading and the
          // note. Without one, the smooth line existed only on the canvas: a table-only reader was
          // handed the raw readings and nothing at all of the line drawn through them, which is the
          // same canvas-and-table split the band toggle one card away was built to close. Absent
          // (and only then) the columns are exactly what every other caller has always had, so no
          // chart without a trend grows an empty column.
          columns: [t('charts.columns.date'), unit, ...(hasTrend ? [t('charts.columns.trend')] : []),
            ...(comparing ? [t('charts.columns.lastYear')] : []), t('charts.columns.note')],
          // dayTableRows (base.ts): shared with DailyBars' own accessible table, which needs
          // neither the trend column nor the episodic filter, so both default off there.
          rows: dayTableRows({ values, labels, excluded, annotations, format, t, episodic, trend, hasTrend,
            lastYear: comparing ? lastYear : undefined, standings: dots ? pointStandings : undefined }),
        }} />
      {/* The band itself is drawn on the chart's canvas (markArea above), which a test cannot
          query. Same deliberate, invisible seam as HeartRateRange's own sentinel, so a test can
          assert the band's presence without depending on echarts' internal structure. */}
      {(baseline || bands?.some((band) => band !== null)) && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
