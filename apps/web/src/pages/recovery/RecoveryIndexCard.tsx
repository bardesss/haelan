import { BASELINE_WINDOW_DAYS } from '@haelan/core/baseline-window'
import { bandOf } from '@haelan/core/recovery-index'
import type { RecoveryInput } from '@haelan/core/recovery-index'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { Sparkline } from '../../charts/Sparkline.js'
import { useRecoveryIndex } from '../../data/useRecoveryIndex.js'
import { formatNumber, formatLocalDate } from '../../format.js'

/**
 * The scored date, or null when it IS today.
 *
 * Exported so the rule can be asserted without mounting. This archive routinely lags sync by
 * several days, and a prominent number from last Sunday with nothing saying so is worse than a
 * quiet one. The mechanism is the scored date itself, NOT M6a's staleness read: that judges
 * whether a source has gone quiet against its own cadence, which is a different question and one
 * this card does not need to ask.
 */
export function asOfLabel(scored: string, today: string): string | null {
  return scored === today ? null : scored
}

export interface ContributionRow {
  key: RecoveryInput['key']
  points: number
}

/**
 * The inputs, largest mover first, with points rounded to whole numbers.
 *
 * Exported so the ordering can be asserted without mounting. Largest-first rather than a fixed
 * order because the question this card answers is "what moved it", and an input that moved it by
 * a point is not the answer however important it usually is.
 *
 * These do NOT sum to the headline's distance from 50, except on a day every input pushed the
 * same way: `RecoveryInput.points` (packages/core/src/api/recoveryIndex.ts) is scaled by the
 * total absolute movement across inputs, not by the signed composite, so two inputs pulling in
 * opposite directions genuinely cancel rather than adding up to the score. This list never claims
 * a total.
 */
export function contributionRows(inputs: readonly RecoveryInput[]): ContributionRow[] {
  return [...inputs]
    .map((input) => ({ key: input.key, points: Math.round(input.points) }))
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
}

/** The index's own history over the page's range, and what moved the latest one. */
export function RecoveryIndexCard({ from, to, source, today, span = 8 }: {
  from: string
  to: string
  source: string
  today: string
  span?: number
}) {
  const { t, i18n } = useTranslation()
  const { query, byDate, latest } = useRecoveryIndex({ from, to }, source)

  if (query.isError) {
    return (
      <Card span={span} label={t('recoveryIndex.label')}>
        <ErrorState onRetry={() => void query.refetch()} error={query.error} />
      </Card>
    )
  }
  if (query.isPending || byDate === undefined) {
    return <Card span={span} label={t('recoveryIndex.label')}><Loading /></Card>
  }
  if (latest === undefined) {
    return (
      <Card span={span} label={t('recoveryIndex.label')}>
        <p className="recovery-index-empty">{t('recoveryIndex.unavailable')}</p>
      </Card>
    )
  }

  // Sparkline (charts/Sparkline.tsx) takes dense `values`/`labels` pairs over one axis, not a
  // `{ localDate, value }[]` of points - every other caller on this page builds its sparklines
  // this same way (Recovery.tsx's own `sparklines` memo). A day that could not be scored
  // (`enough: false`) contributes `null`, not its z-less composite and not a zero: `null` is what
  // both the canvas (a break in the line, `connectNulls` defaults false) and the accessible table
  // (`charts.absence.noReading`) already render as "nothing to report" for every other chart here,
  // and a scoreless day drawn as 0 would read as the worst possible score instead of as absent.
  const sorted = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
  const labels = sorted.map(([localDate]) => localDate)
  const values = sorted.map(([, index]) => (index.enough ? index.score : null))

  // No catalogue entry names a unit for this score (it is not a METRICS metric, and band copy is
  // barred from ever calling it a "score"), so `metric` is a placeholder never actually read:
  // `formatValue` below is supplied unconditionally, and Sparkline's own formatter only falls
  // back to `formatMetricValue(value, metric, ...)` when a caller omits `formatValue`.
  const formatScore = (value: number | null, absent: string): string => formatNumber(value, 0, i18n.language, absent)

  // The scored day, when it is not today (asOfLabel above): this archive routinely lags sync by
  // several days, and a headline that said nothing about it would pass last Sunday off as today.
  const asOf = asOfLabel(latest.date, today)
  const basis = [
    t('recoveryIndex.basis', { days: BASELINE_WINDOW_DAYS }),
    asOf === null ? undefined : t('recoveryIndex.asOf', { date: formatLocalDate(asOf, i18n.language) }),
  ].filter((part): part is string => part !== undefined).join('; ')

  return (
    <Card span={span} label={t('recoveryIndex.label')}>
      <StatTile
        label={t(`recoveryIndex.band.${bandOf(latest.index.score)}`)}
        value={String(latest.index.score)}
        basis={basis}
      >
        <Sparkline values={values} labels={labels} metric="recovery_index" formatValue={formatScore}
          label={t('recoveryIndex.label')} unit={t('recoveryIndex.label')} />
      </StatTile>
      <ul className="recovery-index-contributions">
        {contributionRows(latest.index.inputs).map((row) => (
          <li key={row.key}>
            <span>{t(`recoveryIndex.input.${row.key}`)}</span>
            <span>{t('recoveryIndex.points', { points: row.points > 0 ? `+${row.points}` : String(row.points) })}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
