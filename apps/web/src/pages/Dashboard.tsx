import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { usePageControls } from '../controls/usePageControls.js'
import { useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { emptyStateFor } from '../data/emptyState.js'
import type { EmptyStateKind } from '../data/emptyState.js'
import { formatDuration, trend } from '../format.js'

// /series takes a repeated metric parameter but exactly one `agg` for the whole call
// (requireMetricAndAgg in packages/core/src/query/personQuery.ts checks every metric against
// that same value), and a metric only has rows under the aggs its own catalogue entry lists. So
// "one request per card" is not achievable here: the four card metrics need three different aggs,
// and asking heart_rate or resting_heart_rate for 'sum' (or steps for 'last') 500s the whole
// request, not just that metric. What is achievable, and what actually prevents four separate
// round trips, is one request per distinct agg, with every metric that shares an agg riding along.
//
// Checked against packages/core/src/derive/metrics.ts rather than against the card labels:
// 'sleep_minutes' is not a metric the catalogue defines, so this uses 'sleep_asleep_minutes', the
// real id for the summed minutes a night's sleep segments cover. 'steps', 'resting_heart_rate' and
// 'heart_rate' are real ids as written. Per the catalogue: steps and sleep_asleep_minutes are
// TOTAL metrics (aggs: ['sum']); resting_heart_rate is a once-a-day reading (aggs: ['last'], no
// 'mean' to average since there is only ever one row a day to begin with); heart_rate is intraday
// (aggs: ['min', 'mean', 'max', 'p50', 'count']) and 'mean' is what its own card claims to show,
// both in its label ("Mean heart rate") and its basis line ("mean, ... days").
//
// apps/web does not depend on @haelan/core (BackfillStep.tsx documents the same boundary for the
// intraday cap): that package's one export pulls in better-sqlite3 and argon2, native modules a
// browser bundle cannot carry. So this mapping is written out here rather than imported, which
// duplicates a fact the catalogue also states; it is confined to this one place instead of spread
// across every card, and it is exactly the id-to-agg pairing above, nothing wider.
const SUM_METRICS = ['steps', 'sleep_asleep_minutes'] as const
const LAST_METRICS = ['resting_heart_rate'] as const
const MEAN_METRICS = ['heart_rate'] as const

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

export function Dashboard() {
  const { t, i18n } = useTranslation()
  const controls = usePageControls()
  const range = { from: controls.from, to: controls.to, source: controls.source }

  // Three calls, not one per metric and not a variable number: the groups above are a fixed
  // constant, never derived from a response, so this hook runs the same three times in the same
  // order on every render regardless of what any of them returns.
  const sumSeries = useSeries([...SUM_METRICS], range, 'sum')
  const lastSeries = useSeries([...LAST_METRICS], range, 'last')
  const meanSeries = useSeries([...MEAN_METRICS], range, 'mean')

  const groups = [
    { metrics: SUM_METRICS as readonly string[], query: sumSeries },
    { metrics: LAST_METRICS as readonly string[], query: lastSeries },
    { metrics: MEAN_METRICS as readonly string[], query: meanSeries },
  ]
  const queryFor = (metric: string) => groups.find((g) => g.metrics.includes(metric))!.query

  // The active language, not a pinned locale: a bilingual app whose numbers only ever group like
  // English is not actually speaking Dutch when it renders Dutch.
  const groupNumber = (value: number) => value.toLocaleString(i18n.language)

  const pointsOf = (metric: string): SeriesPoint[] => queryFor(metric).data?.[metric]?.points ?? []

  // Coverage is per point and comes straight off the envelope, so the basis line states what the
  // number actually rests on rather than asserting a figure nobody computed.
  const basisOf = (points: SeriesPoint[]) => {
    const worn = points.filter((p) => p.coverage !== null && p.coverage > 0).length
    return { worn, total: points.length, unworn: points.length - worn }
  }

  const tile = (
    metric: string, labelKey: string, chartLabelKey: string, unitKey: string,
    format: (points: SeriesPoint[]) => string,
    direction: 'higher-is-better' | 'lower-is-better' | 'neutral',
    unit?: string,
  ) => {
    const points = pointsOf(metric)
    const empty: EmptyStateKind | null = queryFor(metric).isPending ? null : emptyStateFor(points)
    if (empty !== null) {
      return <EmptyState title={t(`emptyState.${empty}.title`)} detail={t(`emptyState.${empty}.detail`)} />
    }
    // Undefined rather than a delta computed over nothing: the isPending check above already
    // forces empty to null so the tile does not flash "no_data" while the first fetch is still in
    // flight, but trend() divides by the length of what it is handed, so that same window would
    // hand it two empty halves and print "NaN%" for the instant before real points arrive.
    return (
      <StatTile label={t(labelKey)} value={format(points)} unit={unit}
        basis={t(`${labelKey.replace('.label', '')}.basis`, basisOf(points))}
        delta={points.length > 0 ? trend(t, values(points), direction) : undefined}>
        <Sparkline values={points.map((p) => p.value)} labels={points.map((p) => p.localDate)}
          label={t(chartLabelKey, { period: `${controls.from} to ${controls.to}` })} unit={t(unitKey)} />
      </StatTile>
    )
  }

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
      <ControlRow controls={controls} sources={[]} syncedMinutesAgo={0} />
      <div className="grid">
        <Card span={3}>
          {tile('steps', 'dashboard.steps.label', 'dashboard.steps.chartLabel', 'dashboard.units.steps',
            (p) => groupNumber(values(p).reduce((a, b) => a + b, 0)), 'higher-is-better')}
        </Card>
        <Card span={3}>
          {tile('resting_heart_rate', 'dashboard.restingHr.label', 'dashboard.restingHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'lower-is-better', t('dashboard.units.bpm'))}
        </Card>
        <Card span={3}>
          {tile('sleep_asleep_minutes', 'dashboard.sleep.label', 'dashboard.sleep.chartLabel',
            'dashboard.units.minutesAsleep',
            (p) => formatDuration(mean(values(p))), 'higher-is-better')}
        </Card>
        <Card span={3}>
          {tile('heart_rate', 'dashboard.meanHr.label', 'dashboard.meanHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'neutral', t('dashboard.units.bpm'))}
        </Card>
      </div>
    </>
  )
}
