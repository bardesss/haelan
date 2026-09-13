import { useTranslation } from '../../i18n/index.js'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { Card } from '../../components/Card.js'
import { ErrorState } from '../../components/ErrorState.js'
import { StatTile } from '../../components/StatTile.js'
import { useMetricGroups } from '../../data/useMetricGroups.js'
import type { MetricGroup } from '../../data/useMetricGroups.js'
import { formatDuration, formatMetricValue } from '../../format.js'

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

  // Every other tile group on this page's siblings (and every MetricCard-backed card on every
  // other page) gates on its own query's isError before ever reading its points: an errored query
  // has isPending false and data undefined, the identical shape to a query that succeeded and
  // simply has nothing for this night, so without this check a failed /series request renders as
  // "this night has no time asleep, no deep sleep, no efficiency" - the false claim NightTraces.tsx
  // and NightStages.tsx both argue against in their own comments, applying identically here. All
  // three groups are retried together, not just whichever one happened to fail, the same shape
  // NotesList.tsx's own multi-query retry uses: a reader clicking "Try again" wants every figure on
  // this row back, not a partial retry that leaves a second group silently stale.
  if (groups.queries.some((query) => query.isError)) {
    return <Card span={12}><ErrorState onRetry={() => { for (const query of groups.queries) void query.refetch() }} /></Card>
  }

  const valueFor = (metric: string) => valueOf(groups.pointsOf(metric))
  // Typed explicitly, rather than inferred from the literal array below, because only one of the
  // eight entries carries `unit` (efficiency): without this annotation TypeScript narrows the
  // array to a union of "has unit" and "has no unit" shapes, and the flatMap below would then need
  // its own type guard just to read `tile.unit` at all.
  const sources: { key: string, metric: string, duration: boolean, unit?: string }[] = [
    { key: 'asleep', metric: 'sleep_asleep_minutes', duration: true },
    { key: 'inBed', metric: 'sleep_in_bed_minutes', duration: true },
    // unit: reuses Sleep.tsx's own key for the identical figure rather than adding a second one -
    // see the precision comment below for why the value itself still comes from this page's own
    // request rather than Sleep's.
    { key: 'efficiency', metric: 'sleep_efficiency', duration: false, unit: 'sleep.units.percentShort' },
    { key: 'deep', metric: 'sleep_deep_minutes', duration: true },
    { key: 'light', metric: 'sleep_light_minutes', duration: true },
    { key: 'rem', metric: 'sleep_rem_minutes', duration: true },
    { key: 'awake', metric: 'sleep_awake_minutes', duration: true },
    { key: 'naps', metric: 'sleep_nap_count', duration: false },
  ]
  // The explicit `: {...}[]` return annotation, not left to inference, is what keeps `text` on the
  // result: without it TypeScript widens the two flatMap branches (`[]` and `[{...tile, text}]`)
  // back down to `typeof sources[number]`, which is missing `text` and breaks `tile.text` below.
  const tiles = sources.flatMap((tile): (typeof tile & { text: string })[] => {
    const value = valueFor(tile.metric)
    // Absent, never empty: this night having no row for a metric is not the same statement as a
    // recorded zero, so the tile disappears instead of printing one.
    if (value === null) return []
    return [{
      ...tile,
      // formatMetricValue, not a hardcoded literal precision: sleep_efficiency and sleep_nap_count
      // both declare precision 0 in the catalogue, which is exactly the number a threaded literal
      // here used to repeat by hand - the identical drift format.ts's own comment on
      // formatMetricValue names Sleep.tsx's hardcoded 0 for. formatMetricValue does not clamp
      // (it is formatNumber(value, METRICS[metric].precision, ...) and nothing else), so the
      // figure is still shown exactly as derived: overlapping sleep sessions can push
      // sleep_efficiency above 100, a known derivation gap pinned by
      // packages/core/test/sleep-derive.test.ts ("KNOWN GAP: overlapping sessions within a night
      // double count toward asleep and efficiency"), and clamping here would hide that real defect
      // behind a plausible-looking figure, on the one surface that shows it most prominently.
      text: tile.duration ? formatDuration(value) : formatMetricValue(value, tile.metric, i18n.language, ''),
    }]
  })

  if (tiles.length === 0) return null

  return (
    <div className="night-tiles">
      {tiles.map((tile) => (
        <Card key={tile.key} span={3}>
          <StatTile label={t(`sleep.night.tiles.${tile.key}`)} value={tile.text}
            unit={tile.unit ? t(tile.unit) : undefined}
            basis={t('sleep.night.tileBasis', { metric: tile.metric })} />
        </Card>
      ))}
    </div>
  )
}
