import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { StackedDailyBars } from '../../../charts/StackedDailyBars.js'
import type { BandSeries } from '../../../charts/StackedDailyBars.js'
import type { ChartTokens } from '../../../charts/tokens.js'
import { formatDuration, formatNumber } from '../../../format.js'
import type { PeriodFigure, SleepPeriodData } from '../../../data/periodTypes.js'

type Stage = 'deep' | 'light' | 'rem' | 'awake'
const STAGES: readonly { stage: Stage, token: keyof ChartTokens }[] = [
  { stage: 'deep', token: 'stageDeep' },
  { stage: 'light', token: 'stageLight' },
  { stage: 'rem', token: 'stageRem' },
  { stage: 'awake', token: 'stageAwake' },
]

// A stage's points: its weeks on 3 months and Year, its nights otherwise.
const pointsOf = (figure: PeriodFigure) => figure.weekly ?? figure.daily

/**
 * "De nachten": each night's stages as one stacked bar (each week's averages on 3 months and Year),
 * in the stages' own colours, the night page's legend under it with the period's average of each
 * and its share of the night (the server's `shares`). The axis runs along whichever stage the
 * server sent; the four share it, since each figure's points cover the same period. Nothing at
 * all when the server sent no stage.
 */
export function SleepStages({ stages }: { stages: SleepPeriodData['stages'] }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const legendId = useId()
  const present = useMemo(() => STAGES.flatMap(({ stage, token }) => {
    const figure = stages[stage]
    return figure === null ? [] : [{ stage, token, figure }]
  }), [stages])
  const labels = useMemo(() => (present[0] === undefined ? [] : pointsOf(present[0].figure).map((point) => point.from)), [present])
  const series = useMemo<BandSeries[]>(() => present.map(({ stage, token, figure }) => ({
    key: figure.metric, name: t(`sleep.stage.${stage}`), token, values: pointsOf(figure).map((point) => point.value),
  })), [present, t])
  if (present.length === 0) return null

  const label = t('sleep.period.stages.label')
  const legend = present.map(({ stage, figure }) => {
    // A value never wraps inside itself: the duration's halves stay together (NightThrough's rule).
    const duration = figure.value === null ? t('common.absent') : formatDuration(figure.value, language).replace(' ', ' ')
    const share = stages.shares?.[stage]
    const text = share === undefined
      ? duration
      : t('sleep.night.through.share', { duration, percent: formatNumber(share * 100, 0, language, t('common.absent')) })
    return { stage, text: `${t(`sleep.stage.${stage}`)} ${text}` }
  })

  return (
    <Card span={12} label={label}>
      <BasisContext.Provider value={legendId}>
        <StackedDailyBars series={series} labels={labels} label={label} unit={t('sleep.units.minutes')}
          axisUnit={t('sleep.units.minutes')} metric="sleep_deep_minutes" />
      </BasisContext.Provider>
      <ul className="detail-legend" id={legendId}>
        {legend.map(({ stage, text }) => (
          <li key={stage}><span className="detail-legend-key" data-stage={stage} aria-hidden="true" />{text}</li>
        ))}
      </ul>
    </Card>
  )
}
