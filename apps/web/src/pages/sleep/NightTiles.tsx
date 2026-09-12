import { useTranslation } from '../../i18n/index.js'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { useMetricGroups } from '../../data/useMetricGroups.js'
import type { MetricGroup } from '../../data/useMetricGroups.js'
import { formatDuration, formatNumber } from '../../format.js'

/**
 * Exactly the metrics Sleep already requests for this date, and no figure computed here.
 *
 * Section 4's rule: read from the tier 1 daily metrics, never recomputed. Two surfaces computing
 * the same figure two ways is how they come to disagree, and this page sits one click from the one
 * that shows the same night's numbers in a chart.
 *
 * The awake tile is time awake rather than a count of awakenings, and the difference matters. There
 * is no awakenings metric in the catalogue at all; counting AWAKE segments here would be this page
 * deriving a figure no derivation owns. sleep_awake_minutes is also not the sum of those segments -
 * derive/sleep.ts adds RESTLESS and the gaps between a night's separate pieces - so a count taken
 * from the segments would not even be a decomposition of the number beside it.
 */
export const NIGHT_REQUESTS = {
  sum: ['sleep_asleep_minutes', 'sleep_in_bed_minutes', 'sleep_deep_minutes',
    'sleep_light_minutes', 'sleep_rem_minutes', 'sleep_awake_minutes'],
  last: ['sleep_efficiency'],
  count: ['sleep_nap_count'],
} as const satisfies Partial<Record<DailyAgg, readonly string[]>>

function under(agg: keyof typeof NIGHT_REQUESTS): string[] {
  return NIGHT_REQUESTS[agg].filter((metric) => METRICS[metric]?.aggs.includes(agg) ?? false)
}

const GROUPS: readonly MetricGroup[] = [
  { agg: 'sum', metrics: under('sum'), covers: NIGHT_REQUESTS.sum },
  { agg: 'last', metrics: under('last'), covers: NIGHT_REQUESTS.last },
  { agg: 'count', metrics: under('count'), covers: NIGHT_REQUESTS.count },
]

/** A night is one date, so a metric has at most one point here; absent means this night has no row
 *  for it, which is not the same statement as a recorded zero and is why the tile disappears
 *  instead of printing one. */
function valueOf(points: { value: number | null }[]): number | null {
  return points[0]?.value ?? null
}

/**
 * Section 4's "Stat tiles" paragraph, plus the design's own indented block on efficiency above
 * 100: `display: contents` (app.css) is the same device WorkoutTiles.tsx uses, so each `Card
 * span={3}` sits in NightDetail's own `.grid` while this wrapper keeps a stable selector for
 * tests, without a nested grid of its own between a tile and the page.
 */
export function NightTiles({ localDate, source }: { localDate: string, source: string }) {
  const { t, i18n } = useTranslation()
  const groups = useMetricGroups(GROUPS, { from: localDate, to: localDate, source })

  const valueFor = (metric: string) => valueOf(groups.pointsOf(metric))
  const tiles = [
    { key: 'asleep', metric: 'sleep_asleep_minutes', duration: true },
    { key: 'inBed', metric: 'sleep_in_bed_minutes', duration: true },
    { key: 'efficiency', metric: 'sleep_efficiency', duration: false },
    { key: 'deep', metric: 'sleep_deep_minutes', duration: true },
    { key: 'light', metric: 'sleep_light_minutes', duration: true },
    { key: 'rem', metric: 'sleep_rem_minutes', duration: true },
    { key: 'awake', metric: 'sleep_awake_minutes', duration: true },
    { key: 'naps', metric: 'sleep_nap_count', duration: false },
  ].flatMap((tile) => {
    const value = valueFor(tile.metric)
    // Absent, never empty: this night having no row for a metric is not the same statement as a
    // recorded zero, so the tile disappears instead of printing one.
    if (value === null) return []
    return [{
      ...tile,
      // Efficiency (and the nap count) print through formatNumber, not formatMetricValue: the
      // figure is shown exactly as derived, never clamped. Overlapping sleep sessions can push
      // sleep_efficiency above 100, which is a known derivation gap pinned by
      // packages/core/test/sleep-derive.test.ts ("KNOWN GAP: overlapping sessions within a night
      // double count toward asleep and efficiency"). Clamping here would hide a real defect
      // behind a plausible-looking figure, on the one surface that shows it most prominently.
      text: tile.duration ? formatDuration(value) : formatNumber(value, 0, i18n.language, ''),
    }]
  })

  if (tiles.length === 0) return null

  return (
    <div className="night-tiles">
      {tiles.map((tile) => (
        <Card key={tile.key} span={3}>
          <StatTile label={t(`sleep.night.tiles.${tile.key}`)} value={tile.text}
            basis={t('sleep.night.tileBasis', { metric: tile.metric })} />
        </Card>
      ))}
    </div>
  )
}
