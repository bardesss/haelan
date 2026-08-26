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

// One request draws all four sparklines. /series takes a repeated metric parameter, which M3b-2
// added for exactly this, so four cards cost one round trip and share one cache entry.
//
// Checked against packages/core/src/derive/metrics.ts rather than against the card labels:
// 'sleep_minutes' is not a metric the catalogue defines, so this uses 'sleep_asleep_minutes',
// the real id for the summed minutes a night's sleep segments cover. 'steps', 'resting_heart_rate'
// and 'heart_rate' are real ids as written.
//
// The catalogue also settles what agg a metric may be read at: steps and sleep_asleep_minutes
// are TOTAL metrics (aggs: ['sum']), resting_heart_rate is a once-a-day reading (aggs: ['last']),
// and heart_rate is intraday (aggs: ['min','mean','max','p50','count'], no 'sum' and no 'last').
// One /series call carries exactly one `agg` for every metric it names, so no single value here
// is valid for all four against the real route (requireMetricAndAgg in personQuery.ts throws for
// whichever of these four does not accept it). 'sum', the default, is the one that keeps steps and
// sleep correct; resting_heart_rate and heart_rate would need 'last' and 'mean' respectively, which
// only fits if they are read apart from this batch. Splitting the request would break the "one
// request for every card metric" contract this very task tests, and widening useSeries to take an
// agg per metric is a change to an earlier task's interface, not this one's. Left as is and
// recorded here rather than hidden, pending whichever later task resolves it.
const CARD_METRICS = ['steps', 'resting_heart_rate', 'sleep_asleep_minutes', 'heart_rate'] as const

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

export function Dashboard() {
  const { t, i18n } = useTranslation()
  const controls = usePageControls()
  const series = useSeries([...CARD_METRICS], { from: controls.from, to: controls.to, source: controls.source })

  // The active language, not a pinned locale: a bilingual app whose numbers only ever group like
  // English is not actually speaking Dutch when it renders Dutch.
  const groupNumber = (value: number) => value.toLocaleString(i18n.language)

  const pointsOf = (metric: string): SeriesPoint[] => series.data?.[metric]?.points ?? []

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
    const empty: EmptyStateKind | null = series.isPending ? null : emptyStateFor(points)
    if (empty !== null) {
      return <EmptyState title={t(`emptyState.${empty}.title`)} detail={t(`emptyState.${empty}.detail`)} />
    }
    // Undefined rather than a delta computed over nothing: series.isPending already forces empty
    // to null above so the tile does not flash "no_data" while the first fetch is still in
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
