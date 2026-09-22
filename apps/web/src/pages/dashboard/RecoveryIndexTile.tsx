import { BASELINE_WINDOW_DAYS } from '@haelan/core/baseline-window'
import { bandOf } from '@haelan/core/recovery-index'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { Sparkline } from '../../charts/Sparkline.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { useRecoveryIndex } from '../../data/useRecoveryIndex.js'
import { formatLocalDate, formatNumber } from '../../format.js'

/**
 * The scored date, or null when it IS today.
 *
 * Exported so the rule can be asserted without mounting. This archive routinely lags sync by
 * several days, and a prominent number from last Sunday with nothing saying so is worse than a
 * quiet one. The mechanism is the scored date itself, NOT M6a's staleness read: that judges
 * whether a source has gone quiet against its own cadence, which is a different question and one
 * this tile does not need to ask.
 */
export function asOfLabel(scored: string, today: string): string | null {
  return scored === today ? null : scored
}

/**
 * The one number summarising four signals, at the top of the landing page.
 *
 * NOT a readiness verdict. The band wording compares the day against the person's own normal and
 * says nothing about what they should do with it.
 *
 * `today` is the caller's job to resolve, not this tile's: `usePageControls` already reads the
 * person's local day off their session timezone (its own `today` field), and reaching for
 * `new Date().toISOString()` here instead would read the UTC date - wrong for part of every day,
 * and a second, disagreeing notion of "today" next to the one this codebase already has.
 */
export function RecoveryIndexTile({ from, to, source, today, span = 4 }: {
  from: string
  to: string
  source: string
  today: string
  span?: number
}) {
  const { t, i18n } = useTranslation()
  // byDate as well as latest, and it costs nothing: this hook already fetches the whole range to
  // find `latest`, so the series the sparkline below draws was being thrown away. Which is what
  // left this card half empty - it sits in a row of tiles that all carry a figure, a basis and a
  // sparkline, and it was the only one with nothing under its number.
  const { query, byDate, latest } = useRecoveryIndex({ from, to }, source)

  if (query.isError) {
    return (
      <Card span={span} label={t('recoveryIndex.label')}>
        <ErrorState onRetry={() => void query.refetch()} error={query.error} />
      </Card>
    )
  }
  if (query.isPending) {
    return <Card span={span} label={t('recoveryIndex.label')}><Loading /></Card>
  }
  if (latest === undefined) {
    // Settled with nothing scorable. Say why rather than "no data", which a reader cannot tell
    // apart from a broken card.
    //
    // `ambient`, not the default: this branch fires alike on a day with a full archive but a thin
    // baseline or a missing HRV row, and on a day nothing was recorded at all. Design spec
    // ("M8's `RecoveryIndexUnavailable`... must render as a stated reason rather than an error or
    // an empty tile") rules out MetricCard's render-nothing answer, so the message has to stay on
    // screen; `ambient` is what keeps that message from being the one thing standing between the
    // page and its own empty state on the second of those two days. See Card.tsx for the shared
    // reasoning with the flagged days card.
    return (
      <Card span={span} label={t('recoveryIndex.label')} ambient>
        <p className="recovery-index-empty">{t('recoveryIndex.unavailable')}</p>
      </Card>
    )
  }

  const asOf = asOfLabel(latest.date, today)
  const basis = [
    t('recoveryIndex.basis', { days: BASELINE_WINDOW_DAYS }),
    asOf === null ? undefined : t('recoveryIndex.asOf', { date: formatLocalDate(asOf, i18n.language) }),
    latest.index.degraded.length === 0
      ? undefined
      : t('recoveryIndex.degraded', {
        inputs: latest.index.degraded.map((key) => t(`recoveryIndex.input.${key}`)).join(', '),
      }),
    // Distinct from degraded above: these inputs were present, just standing on reduced evidence,
    // and reporting them as absent is the exact defect a fix-round review caught (a half-observed
    // week of sleep rendered as "computed without last week's sleep").
    latest.index.reducedWeight.length === 0
      ? undefined
      : t('recoveryIndex.reducedWeight', {
        inputs: latest.index.reducedWeight.map((key) => t(`recoveryIndex.input.${key}`)).join(', '),
      }),
  ].filter((part): part is string => part !== undefined).join('; ')

  // Built exactly as RecoveryIndexCard.tsx builds its own, including the part that matters: a day
  // that could not be scored contributes `null`, not a zero. Sparkline breaks the line there and
  // the accessible table says "no reading", where a 0 would draw the worst possible score on a day
  // nothing was known about. See that file's own comment for the longer version.
  //
  // byDate is undefined only while the query is still pending, which the branches above have
  // already returned for - but this renders without a sparkline rather than asserting, because an
  // empty tile is a worse answer than a tile with no chart.
  const sorted = [...(byDate ?? new Map()).entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
  const labels = sorted.map(([localDate]) => localDate)
  const values = sorted.map(([, index]) => (index.enough ? index.score : null))

  // `metric` is a placeholder here for the same reason it is on the Recovery page: the index is
  // not a METRICS entry and has no catalogue unit, and Sparkline only falls back to the catalogue
  // formatter when a caller omits formatValue, which this one does not.
  const formatScore = (value: number | null, absent: string): string =>
    formatNumber(value, 0, i18n.language, absent)

  return (
    <Card span={span} label={t('recoveryIndex.label')}>
      <StatTile
        label={t(`recoveryIndex.band.${bandOf(latest.index.score)}`)}
        value={String(latest.index.score)}
        basis={basis}
      >
        {/* One point is a dot, not a trend, and the sparkline's own axis has nothing to say about
            it - the same swap every tile on this page makes for a one day range through
            MetricCard's `oneDayRange`. This card does not go through MetricCard, so it asks the
            question itself: fewer than two scored days is not a line. */}
        {values.filter((value) => value !== null).length > 1 && (
          <Sparkline values={values} labels={labels} metric="recovery_index" formatValue={formatScore}
            label={t('recoveryIndex.label')} unit={t('recoveryIndex.label')} />
        )}
      </StatTile>
    </Card>
  )
}
