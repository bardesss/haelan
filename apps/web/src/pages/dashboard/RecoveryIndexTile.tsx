import { BASELINE_WINDOW_DAYS } from '@haelan/core/baseline-window'
import { bandOf } from '@haelan/core/recovery-index'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { useRecoveryIndex } from '../../data/useRecoveryIndex.js'

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
  const { t } = useTranslation()
  const { query, latest } = useRecoveryIndex({ from, to }, source)

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
    return (
      <Card span={span} label={t('recoveryIndex.label')}>
        <p className="recovery-index-empty">{t('recoveryIndex.unavailable')}</p>
      </Card>
    )
  }

  const asOf = asOfLabel(latest.date, today)
  const basis = [
    t('recoveryIndex.basis', { days: BASELINE_WINDOW_DAYS }),
    asOf === null ? undefined : t('recoveryIndex.asOf', { date: asOf }),
    latest.index.degraded.length === 0
      ? undefined
      : t('recoveryIndex.degraded', {
        inputs: latest.index.degraded.map((key) => t(`recoveryIndex.input.${key}`)).join(', '),
      }),
  ].filter((part): part is string => part !== undefined).join('; ')

  return (
    <Card span={span} label={t('recoveryIndex.label')}>
      <StatTile
        label={t(`recoveryIndex.band.${bandOf(latest.index.score)}`)}
        value={String(latest.index.score)}
        basis={basis}
      />
    </Card>
  )
}
