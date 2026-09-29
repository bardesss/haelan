import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase } from './base.js'
import { scaleStops } from './tokens.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatNumber } from '../format.js'

/**
 * The four session zones, light to peak, in the fixed order colours are assigned from.
 *
 * Moved here from WorkoutZones.tsx (which still owns what the zones ARE, and why they are not the
 * intraday active-zone-minutes three - see zoneRows' own comment there) because this is the one
 * place that actually needs a stable ordinal per zone: `rows` below only ever carries the zones a
 * session recorded, in this same order but with any zone the session skipped missing outright, so a
 * row's own position in `rows` cannot be used to pick its colour - a light+peak session and a
 * peak-only session would otherwise draw peak in two different stops. Indexing by each row's own
 * `zone` against this fixed list keeps a zone's colour the same regardless of which of the other
 * three a given session happened to record. WorkoutZones.tsx imports this back for its own
 * iteration order.
 */
export const SESSION_ZONE_KEYS = ['light', 'moderate', 'vigorous', 'peak'] as const

/**
 * The four zones in four distinct colours, for the workout page (M10a-3): the approved mockup's
 * light blue, blue, amber and red, each its own chart role (packages/tokens chart.ts's zone-*).
 * Still ordered light to dark to warm, so the eye reads a scale. Shared with the trace's zone bands
 * (WorkoutThrough.tsx), so a zone is the same colour on the bar and behind the line.
 */
export const ZONE_TOKENS: Record<(typeof SESSION_ZONE_KEYS)[number], keyof ChartTokens> = {
  light: 'zoneLight', moderate: 'zoneModerate', vigorous: 'zoneVigorous', peak: 'zonePeak',
}

export interface ZoneRow { zone: (typeof SESSION_ZONE_KEYS)[number], label: string, minutes: number }

const HEIGHT = 48

/**
 * One horizontal stacked bar: the session's time in each zone, in order, on the sequential ramp.
 *
 * The ramp rather than four hand-picked colours, because zones are ordered - light through peak is
 * a scale, not four categories - and scaleStops is the ordered ramp this app already publishes, low
 * value first (scaleStops' own comment): light gets the low-value stop, peak the high-value one.
 * Which literal colour that is flips between themes (packages/tokens/src/chart.ts's own dark/light
 * scale-1..5), so "lightest first" would only describe the light theme - the drawn order matching
 * the read order is the constant, not any one colour being at either end.
 */
export function ZoneBar({ rows, label, distinct = false }: {
  rows: readonly ZoneRow[]
  label: string
  /** Four distinct zone colours (ZONE_TOKENS) instead of the ramp; the workout page's zones card. */
  distinct?: boolean
}) {
  const { t, i18n } = useTranslation()
  // Minutes by the short-span rule the zones legend follows ("2 min"), never a duration's "0h 02m":
  // a zone is only ever a few minutes, and the legend and this table print the same figure.
  const minutes = useCallback(
    (value: number) => `${formatNumber(value, 0, i18n.language, '')}\u00a0${t('activity.units.min')}`,
    [i18n.language, t],
  )

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    const stops = scaleStops(tokens)
    return {
      grid: base.grid({ left: 8, right: 8, top: 8, bottom: 8 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'item' as const,
        formatter: (params: unknown) => {
          const p = params as { seriesName?: string, value?: number }
          return `${p.seriesName ?? ''}: ${minutes(Number(p.value ?? 0))}`
        },
      },
      // No labels on either axis: one bar needs no scale (its last two ticks collided, "30" over
      // "31"), and the category's one label repeated the card's own inside the chart.
      xAxis: { type: 'value' as const, ...base.hiddenAxis, axisLabel: { show: false }, splitLine: { show: false }, max: rows.reduce((a, r) => a + r.minutes, 0) || 1 },
      yAxis: { type: 'category' as const, data: [label], ...base.hiddenAxis, axisLabel: { show: false } },
      // Indexed by the zone's own fixed position, not by the row's position in `rows`: a session
      // that skipped a zone still draws its remaining zones in their own true colours rather than
      // sliding them into the gap. Final review finding.
      series: rows.map((row) => ({
        name: row.label,
        type: 'bar' as const,
        stack: 'zones',
        data: [row.minutes],
        itemStyle: {
          color: distinct ? tokens[ZONE_TOKENS[row.zone]] : stops[SESSION_ZONE_KEYS.indexOf(row.zone) % stops.length]!,
        },
      })),
    }
  }, [rows, label, distinct, minutes])

  const { host, style } = useChart(build, HEIGHT)

  return (
    <ChartFigure
      label={label}
      host={host}
      style={style}
      table={{
        // "Duration", not "Minutes": each cell carries its own unit ("2 min"), and a header of
        // "Minutes" over it would say the unit twice (activity.units.minutes is a StatTile unit).
        columns: [t('activity.workout.zones.column'), t('activity.workout.zones.duration')],
        rows: rows.map((row) => [row.label, minutes(row.minutes)]),
      }}
    />
  )
}
