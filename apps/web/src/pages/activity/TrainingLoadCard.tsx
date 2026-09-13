import { CARDIO_LOAD_METRIC } from '@haelan/core/cardio-load'
import { MIN_WORN_CHRONIC, CHRONIC_DAYS, ACUTE_DAYS } from '@haelan/core/training-load'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { useTrainingLoad } from '../../data/useTrainingLoad.js'
import { formatMetricValue, formatNumber } from '../../format.js'

/**
 * This week's cardio load against the month behind it.
 *
 * The target is not a number anybody typed. It IS the chronic load, so "this week against its
 * target" and "the ratio" are one statement read two ways, which is why this card shows a single
 * comparison rather than a figure and a goal that could drift apart.
 *
 * Deliberately NOT a risk band. The conventional reading of this ratio is framed as injury risk,
 * and a personal archive is not licensed to say that, so the wording compares the person against
 * their own recent habit and stops there.
 */
export function TrainingLoadCard({ on, source, span = 6 }: {
  on: string
  source: string
  span?: number
}) {
  const { t, i18n } = useTranslation()
  const { query, load } = useTrainingLoad(on, source)

  const format = (value: number): string =>
    formatMetricValue(value, CARDIO_LOAD_METRIC, i18n.language, '')

  if (query.isError) {
    return (
      <Card span={span} label={t('activity.trainingLoad.label')}>
        <ErrorState onRetry={() => void query.refetch()} />
      </Card>
    )
  }
  if (query.isPending || load === undefined) {
    return (
      <Card span={span} label={t('activity.trainingLoad.label')}><Loading /></Card>
    )
  }

  // Below the floor the card says how far off it is rather than "no data", which a reader cannot
  // tell apart from a broken card.
  if (!load.enough) {
    return (
      <Card
        span={span}
        label={t('activity.trainingLoad.label')}
        basis={t('activity.trainingLoad.basisNotEnough', {
          worn: load.wornChronic, needed: MIN_WORN_CHRONIC, total: CHRONIC_DAYS,
        })}
      >
        <p className="empty">{t('activity.trainingLoad.notEnough')}</p>
      </Card>
    )
  }

  const ratioText = load.ratio === null
    ? t('activity.trainingLoad.noUsual')
    : t('activity.trainingLoad.ratio', { ratio: formatNumber(load.ratio, 2, i18n.language, '') })

  return (
    <Card span={span}>
      <StatTile
        label={t('activity.trainingLoad.label')}
        value={format(load.acute)}
        unit={t('activity.units.trimp')}
        basis={t('activity.trainingLoad.basis', {
          acuteDays: ACUTE_DAYS,
          chronicDays: CHRONIC_DAYS,
          worn: load.wornChronic,
        })}
      >
        <p className="training-load-ratio">{ratioText}</p>
        <p className="training-load-target">
          {t('activity.trainingLoad.target', { target: format(load.target) })}
        </p>
      </StatTile>
    </Card>
  )
}
