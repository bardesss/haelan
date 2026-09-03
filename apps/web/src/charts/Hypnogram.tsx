import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, ANNOTATION_JOIN } from './base.js'
import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'
import { stageMark, STAGE_LABEL_KEY } from './stage.js'
import { ChartFigure } from './ChartFigure.js'
import { formatDuration } from '../format.js'
import { useTranslation } from '../i18n/index.js'

const LANES: Stage[] = ['awake', 'rem', 'light', 'deep']

const MINUTE_MS = 60_000

// Reading order for the totals row: deep to awake, the same order sleep.stage's own keys are
// declared in the catalogue (en.json/nl.json), rather than LANES' chart-drawing order (awake at
// the top of the plot, deep at the bottom).
const STAGE_ORDER: Stage[] = ['deep', 'light', 'rem', 'awake']

/**
 * Per-stage minutes from the segments a hypnogram draws, summed in milliseconds and rounded once
 * rather than rounded per segment and then summed. packages/core/src/derive/sleep.ts's own
 * asMinutes comment states why the latter inflates a total against the provider's 30 second grid:
 * of 5,904 real segments, 3,136 sat exactly 30 seconds over a minute and rounded up, none rounded
 * down, 1,568 invented minutes across one household's history before #85 fixed it there. This is
 * the same rule, kept for the chart that draws the segments the derivation totals from.
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

export function Hypnogram({ segments, startLabel, label }: {
  segments: { stage: Stage; from: number; to: number }[]
  startLabel: string
  label: string
}) {
  const { t } = useTranslation()

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    return {
      grid: base.grid({ left: 46, top: 10 }),
      xAxis: { type: 'value' as const, min: 0, max: segments.at(-1)?.to ?? 480,
        axisLabel: { ...base.axisLabel, formatter: (v: number) => `${Math.floor(v / 60)}h` },
        splitLine: base.splitLine },
      yAxis: { type: 'category' as const, data: [...LANES].reverse(),
        axisLabel: base.axisLabel, ...base.hiddenAxis },
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
          const height = laneHeight * 0.45
          const mark = stageMark(stage as Stage, tokens)
          return {
            type: 'rect',
            shape: { x: start[0] ?? 0, y: (start[1] ?? 0) - height / 2, width: (end[0] ?? 0) - (start[0] ?? 0), height },
            style: { fill: mark.fill, stroke: mark.outline, lineWidth: mark.outlineWidth },
          }
        },
        encode: { x: [0, 1], y: 2 },
        data: segments.map((s) => [s.from, s.to, LANES.length - 1 - LANES.indexOf(s.stage)]),
      }],
      graphic: [{ type: 'text' as const, left: 46, top: 0,
        style: { text: startLabel, fill: tokens.muted, fontSize: base.axisLabel.fontSize } }],
    }
  }, [segments, startLabel])

  const { host, style } = useChart(build, 130)

  // Same segments the chart above draws, from/to in minutes as Sleep.tsx builds this prop,
  // multiplied out to milliseconds only so stageTotals can do its own single rounding rather than
  // round twice. Never the daily sleep_*_minutes metrics: those are period aggregates while this
  // chart shows one night, and reading them here could print a total the bars above disagree with,
  // an invariant this project has had to repair three times already.
  const totals = stageTotals(segments.map((s) => ({ stage: s.stage, startMs: s.from * MINUTE_MS, endMs: s.to * MINUTE_MS })))
  const minutesByStage = new Map(totals.map((total) => [total.stage, total.minutes]))
  const totalsRow = STAGE_ORDER
    .filter((stage) => minutesByStage.has(stage))
    .map((stage) => `${t(STAGE_LABEL_KEY[stage])} ${formatDuration(minutesByStage.get(stage)!)}`)
    .join(ANNOTATION_JOIN)

  return (
    <>
      <ChartFigure label={label} host={host} style={style}
        table={{
          columns: [t('charts.columns.from'), t('charts.columns.to'), t('charts.columns.stage'), t('charts.columns.duration')],
          rows: segments.map((s) => [
            formatDuration(s.from), formatDuration(s.to), t(STAGE_LABEL_KEY[s.stage]), formatDuration(s.to - s.from),
          ]),
        }} />
      {/* Empty totals is a classic (ASLEEP/RESTLESS-only) night, which carries no DEEP/LIGHT/REM
          segment at all: both callers' own stageOf (Sleep.tsx, Dashboard.tsx) already drop those
          two stages before this component ever sees them, so an empty `segments` here means no
          staging happened, not that staging happened and found nothing. A blank row or three
          invented zeros would claim a measurement that was never taken, so this states the
          absence instead. */}
      <p className="hypnogram-totals">
        {totals.length === 0 ? t('charts.absence.notStaged') : totalsRow}
      </p>
    </>
  )
}
