import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, ANNOTATION_JOIN } from './base.js'
import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'
import { stageMark, STAGE_LABEL_KEY } from './stage.js'
import { ChartFigure } from './ChartFigure.js'
import { formatClock, formatDuration } from '../format.js'
import { useTranslation } from '../i18n/index.js'
import { hypnogramTooltip } from './hypnogramTooltip.js'

const LANES: Stage[] = ['awake', 'rem', 'light', 'deep']

const MINUTE_MS = 60_000

// Reading order for the totals row: deep to awake, the same order sleep.stage's own keys are
// declared in the catalogue (en.json/nl.json), rather than LANES' chart-drawing order (awake at
// the top of the plot, deep at the bottom).
const STAGE_ORDER: Stage[] = ['deep', 'light', 'rem', 'awake']

// The compact form's own separator for its one line of totals, the mockup's "Deep 1h 40m · Light
// 3h 50m": a list of four short figures on a faint line, where the full form's ", " and closing
// full stop read as the sentence its awake note continues.
const COMPACT_JOIN = ' · '

// The compact form's plot height and how much of each lane a block fills: stage blocks alone, no
// axis under them, so the chart is shorter than the full form's 130 and each block is taller in its
// lane, the approved dashboard mockup's proportions.
const COMPACT_HEIGHT = 96
// Spec amendment 2026-09-24 (T2): the night card's compact hypnogram grows to 112px when the card
// has a wide row to itself (span 12) rather than sharing one with another card (span 8, or phone,
// where the compact default above stays) - the approved mockup's own proportions for that layout.
const COMPACT_HEIGHT_TALL = 112
const BLOCK_SHARE = { full: 0.45, compact: 0.75 } as const

/**
 * Per-stage minutes from the segments a hypnogram draws, summed in milliseconds and rounded once
 * rather than rounded per segment and then summed. packages/core/src/derive/sleep.ts's own
 * asMinutes comment states why the latter inflates a total against the provider's 30 second grid:
 * of 5,904 real segments, 3,136 sat exactly 30 seconds over a minute and rounded up, none rounded
 * down, 1,568 invented minutes across one household's history before #85 fixed it there.
 *
 * Hypnogram's own `segments` prop now carries raw millisecond instants rather than pre-rounded
 * minutes (see the review round that reopened this: rounding each boundary to a minute before it
 * reached here, then summing the rounded boundaries, reintroduced the identical class of error
 * one level up, boundary by boundary rather than segment by segment). With that removed, this
 * function's own single rounding is the only rounding a stage's total goes through, so it agrees
 * with derive/sleep.ts's minutesOfStage exactly: both sum the same raw segments the same way.
 *
 * That agreement is with minutesOfStage, which is not the same thing as agreement with every
 * sleep_*_minutes metric derived from it. It holds outright for deep, light and REM, whose metrics
 * are minutesOfStage and nothing more. It does not hold for awake: sleep_awake_minutes is AWAKE
 * plus RESTLESS plus gapMsWithin (derive/sleep.ts), the time between a night's separate pieces, so
 * on any multi-piece night, or any night carrying a RESTLESS segment, that metric is legitimately
 * larger than the awake total this function returns. Neither figure is wrong; they count different
 * things, and the totals row below says which one it is showing rather than leaving a reader to
 * find a card beside it disagreeing.
 *
 * Exported so a test can drive it directly against the exact shape it sums, independent of
 * whatever unit Hypnogram's own `segments` prop happens to carry its boundaries in.
 */
export function stageTotals(
  segments: { stage: string, startMs: number, endMs: number }[],
): { stage: string, minutes: number }[] {
  const msByStage = new Map<string, number>()
  for (const seg of segments) {
    msByStage.set(seg.stage, (msByStage.get(seg.stage) ?? 0) + (seg.endMs - seg.startMs))
  }
  return [...msByStage].map(([stage, ms]) => ({ stage, minutes: Math.round(ms / MINUTE_MS) }))
}

/**
 * The whole clock hours strictly inside a night, in the clock-minute frame the axis plots: every
 * hour for a night up to ten hours, every second hour beyond that so the labels keep their room.
 * Strictly inside, because the bed-time end is rarely a whole hour and the "Bed 23:54" text above
 * the chart already names it. Exported so a test can pin the ticks without reading them back out
 * of a rendered chart.
 */
export function clockHours(startMinute: number, endMinute: number): number[] {
  const step = endMinute - startMinute > 10 * 60 ? 120 : 60
  const out: number[] = []
  for (let v = Math.floor(startMinute / step) * step + step; v < endMinute; v += step) {
    if (v > startMinute) out.push(v)
  }
  return out
}

export function Hypnogram({ segments, startLabel, label, startClock, totals: showTotals = true, compact = false, tall = false }: {
  // startMs/endMs: raw milliseconds from the night's own start, not pre-rounded minutes. Sleep.tsx
  // and Dashboard.tsx used to round each boundary to a whole minute before building this prop; that
  // rounding now happens only here, per displayed value (the axis, a table cell), never before a
  // sum. Two boundaries that round the same way individually can still each carry their own +0 or
  // +0.5 minute of error, and summing rounded boundaries instead of summing the raw span they
  // measured let those per-boundary errors show up as several minutes of drift in a stage's total,
  // against no error at all in stageTotals summing the real durations once.
  segments: { stage: Stage; startMs: number; endMs: number }[]
  startLabel: string
  label: string
  // The local clock minute the night began at, in the bed-time convention (minutes from the local
  // midnight of the date the night ended, so 23:40 is -20). With it the axis reads clock time on
  // whole hours; without it - a night whose bed time was never recorded - elapsed hours, as before.
  startClock?: number | null
  // False drops the stage totals row and its awake note, for a card that prints the night's asleep
  // total already. Nothing passes it: the dashboard's night card became the page's lead and now
  // draws `compact` instead, which keeps a totals line but drops the awake note from it; the
  // absence sentence below is what a caller that drops `totals` outright still gets.
  totals?: boolean
  // The dashboard's form (spec amendment 2026-09-24): the stage blocks and nothing else on the plot
  // (no lane labels, no time axis, no bed label), no visible "show numbers" control (the table stays
  // for a screen reader), and the totals as one faint line without the awake note, which stays on
  // the Sleep and night pages. False, the default, is the chart every other page draws.
  compact?: boolean
  // Compact only: 112px instead of the compact default 96, for the dashboard's night card when it
  // has the row to itself (span 12) rather than sharing one (span 8, or phone). Ignored without
  // `compact` - the full form's height is fixed at 130 regardless.
  tall?: boolean
}) {
  const { t } = useTranslation()
  const origin = startClock ?? null

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    const spanMinutes = (segments.at(-1)?.endMs ?? 480 * MINUTE_MS) / MINUTE_MS
    const shift = origin ?? 0
    // Clock time on whole hours. The axis is plotted in clock minutes, and the ticks are handed to
    // ECharts as the whole hours inside the night rather than left to an interval: an interval
    // counts from the axis minimum, so a 22:54 bed time ticked 23:54, 00:54, 01:54. The old axis
    // let ECharts pick its own spacing in minutes since bed, which is what printed "0h 1h 3h 5h".
    const xAxis = origin === null
      ? { type: 'value' as const, min: 0, max: spanMinutes,
          axisLabel: { ...base.axisLabel, formatter: (v: number) => `${Math.floor(v / 60)}h` },
          splitLine: base.splitLine }
      : (() => {
          const hours = clockHours(shift, shift + spanMinutes)
          return { type: 'value' as const, min: shift, max: shift + spanMinutes,
            axisTick: { customValues: hours },
            axisLabel: { ...base.axisLabel, customValues: hours, formatter: (v: number) => formatClock(v) },
            splitLine: base.splitLine }
        })()
    // Compact: the same axes, hidden. They still carry the extent the blocks are placed against;
    // `show: false` on an axis hides its line, ticks, labels and split lines together.
    const shownX = compact ? { ...xAxis, show: false } : xAxis
    return {
      grid: compact ? { left: 0, right: 0, top: 2, bottom: 2 } : base.grid({ left: 46, top: 10 }),
      tooltip: {
        ...base.tooltip,
        // 'item', not 'axis': this is a custom series of rects on a category y, so the thing a
        // reader points at is one segment, not a column of them sharing an x.
        trigger: 'item' as const,
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : params
          return hypnogramTooltip(segments, (p as { dataIndex?: number } | undefined)?.dataIndex, t, origin)
        },
      },
      xAxis: shownX,
      yAxis: { type: 'category' as const, data: [...LANES].reverse(),
        axisLabel: base.axisLabel, ...base.hiddenAxis, ...(compact && { show: false }) },
      series: [{
        type: 'custom' as const,
        renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
          const laneIndex = Number(api.value(2))
          const stage = LANES[LANES.length - 1 - laneIndex] ?? 'light'
          const start = api.coord([Number(api.value(0)), laneIndex])
          const end = api.coord([Number(api.value(1)), laneIndex])
          // api.size() is typed number | number[] for other coord systems; a category/value grid always returns [x, y].
          const laneSize = api.size?.([0, 1]) ?? 20
          const laneHeight = (Array.isArray(laneSize) ? laneSize[1] : laneSize) ?? 20
          const height = laneHeight * BLOCK_SHARE[compact ? 'compact' : 'full']
          const mark = stageMark(stage as Stage, tokens)
          return {
            type: 'rect',
            shape: { x: start[0] ?? 0, y: (start[1] ?? 0) - height / 2, width: (end[0] ?? 0) - (start[0] ?? 0), height },
            style: { fill: mark.fill, stroke: mark.outline, lineWidth: mark.outlineWidth },
          }
        },
        encode: { x: [0, 1], y: 2 },
        // Minutes only here, for the axis this chart plots on: a fractional x position (a segment
        // starting at 1.5 minutes lands between the 1 and 2 minute gridlines) draws exactly as
        // accurately as a rounded one and does not get summed, so there is no rounding rule to
        // protect here the way there is in stageTotals below.
        data: segments.map((s) => [shift + s.startMs / MINUTE_MS, shift + s.endMs / MINUTE_MS, LANES.length - 1 - LANES.indexOf(s.stage)]),
      }],
      graphic: compact ? [] : [{ type: 'text' as const, left: 46, top: 0,
        style: { text: startLabel, fill: tokens.muted, fontSize: base.axisLabel.fontSize } }],
    }
  }, [segments, startLabel, origin, t, compact])

  // The table's From and To say what the axis says: clock times when the night's start is known.
  const at = (ms: number) => origin === null ? formatDuration(ms / MINUTE_MS) : formatClock(origin + ms / MINUTE_MS)

  const { host, style } = useChart(build, compact ? (tall ? COMPACT_HEIGHT_TALL : COMPACT_HEIGHT) : 130)

  // The same segments the chart above draws, in the same raw milliseconds they already carry: no
  // conversion needed here, since stageTotals sums milliseconds itself. Never the daily
  // sleep_*_minutes metrics: those are period aggregates while this chart shows one night, and
  // reading them here could print a total the bars above disagree with, an invariant this project
  // has had to repair three times already.
  const totals = stageTotals(segments)
  const minutesByStage = new Map(totals.map((total) => [total.stage, total.minutes]))
  const stageFigures = STAGE_ORDER
    .filter((stage) => minutesByStage.has(stage))
    .map((stage) => `${t(STAGE_LABEL_KEY[stage])} ${formatDuration(minutesByStage.get(stage)!)}`)
  const totalsRow = stageFigures.join(ANNOTATION_JOIN)
  // Said out loud, only on a night that actually has an awake total to be read the wrong way.
  //
  // The awake entry above is the one figure in this row that a metric card on the same page can
  // legitimately disagree with: sleep_awake_minutes counts RESTLESS segments and the gaps between
  // a night's separate pieces on top of the AWAKE segments this chart draws (derive/sleep.ts, and
  // stageTotals' own comment above), so the tile is the larger number on any multi-piece night.
  // The alternative was to drop awake from this row entirely, which was rejected: the awake lane
  // is drawn directly above, and a drawn lane with no total is its own inconsistency. Naming what
  // this total counts keeps both figures and makes the difference between them readable instead of
  // leaving a reader to find two numbers for one night and no way to tell which is which.
  const awakeNote = minutesByStage.has('awake') ? ` ${t('charts.hypnogram.awakeNote')}` : ''

  return (
    <>
      <ChartFigure label={label} host={host} style={style} tableToggle={!compact}
        table={{
          columns: [t('charts.columns.from'), t('charts.columns.to'), t('charts.columns.stage'), t('charts.columns.duration')],
          // formatDuration rounds its own argument (Math.round(minutes) internally), so each cell
          // here rounds independently for display, the same as the axis above; it is never summed,
          // so it carries none of the accumulation risk stageTotals' own comment describes.
          rows: segments.map((s) => [
            at(s.startMs), at(s.endMs),
            t(STAGE_LABEL_KEY[s.stage]), formatDuration((s.endMs - s.startMs) / MINUTE_MS),
          ]),
        }} />
      {/* Empty totals is a classic (ASLEEP/RESTLESS-only) night, which carries no DEEP/LIGHT/REM
          segment at all: both callers' own stageOf (Sleep.tsx, Dashboard.tsx) already drop those
          two stages before this component ever sees them, so an empty `segments` here means no
          staging happened, not that staging happened and found nothing. A blank row or three
          invented zeros would claim a measurement that was never taken, so this states the
          absence instead. */}
      {compact ? (
        // The same stageTotals as the full row above it would print, only joined as a list: the
        // figures cannot drift apart between the dashboard and the Sleep page.
        <p className="hypnogram-totals is-compact">
          {totals.length === 0 ? t('charts.absence.notStaged') : stageFigures.join(COMPACT_JOIN)}
        </p>
      ) : showTotals ? (
        <p className="hypnogram-totals">
          {totals.length === 0 ? t('charts.absence.notStaged') : `${totalsRow}.${awakeNote}`}
        </p>
      ) : totals.length === 0 && (
        // Without its totals row a chart of an unstaged night would be an empty plot with nothing
        // to say why, so the absence sentence stays even where the totals themselves are dropped.
        <p className="hypnogram-absence">{t('charts.absence.notStaged')}</p>
      )}
    </>
  )
}
