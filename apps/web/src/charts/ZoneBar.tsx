import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase } from './base.js'
import { scaleStops } from './tokens.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatDuration } from '../format.js'

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
export function ZoneBar({ rows, label }: { rows: readonly ZoneRow[], label: string }) {
  const { t } = useTranslation()

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
          return `${p.seriesName ?? ''}: ${formatDuration(Number(p.value ?? 0))}`
        },
      },
      xAxis: { type: 'value' as const, ...base.hiddenAxis, max: rows.reduce((a, r) => a + r.minutes, 0) || 1 },
      yAxis: { type: 'category' as const, data: [label], ...base.hiddenAxis },
      // Indexed by the zone's own fixed position, not by the row's position in `rows`: a session
      // that skipped a zone still draws its remaining zones in their own true colours rather than
      // sliding them into the gap. Final review finding.
      series: rows.map((row) => ({
        name: row.label,
        type: 'bar' as const,
        stack: 'zones',
        data: [row.minutes],
        itemStyle: { color: stops[SESSION_ZONE_KEYS.indexOf(row.zone) % stops.length]! },
      })),
    }
  }, [rows, label])

  const { host, style } = useChart(build, HEIGHT)

  return (
    <ChartFigure
      label={label}
      host={host}
      style={style}
      table={{
        // "Duration", not "Minutes": the cell below is formatDuration's own "Xh XXm", not a bare
        // minute count, and the header has to say what the cell actually prints. Final review
        // finding - activity.units.minutes ("Minutes") is a StatTile unit elsewhere in this app and
        // was reused here without noticing it no longer matched the cell.
        columns: [t('activity.workout.zones.column'), t('activity.workout.zones.duration')],
        rows: rows.map((row) => [row.label, formatDuration(row.minutes)]),
      }}
    />
  )
}
