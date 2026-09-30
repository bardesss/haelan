import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { StackedDailyBars } from '../../../charts/StackedDailyBars.js'
import type { BandSeries } from '../../../charts/StackedDailyBars.js'
import { periodAxisLabels } from '../../../charts/barAxis.js'
import type { ChartTokens } from '../../../charts/tokens.js'
import type { ActivityPeriodData, PeriodFigure, PeriodRange } from '../../../data/periodTypes.js'
import { thisPeriod } from '../../detail/periodText.js'
import { minutesCount } from './labels.js'

type Band = 'light' | 'moderate' | 'vigorous'
// Literal keys, one per band, for catalogue-usage.test.ts (the old page's rule for these names).
const BANDS: readonly { band: Band, token: keyof ChartTokens, nameKey: string }[] = [
  { band: 'light', token: 'activityLight', nameKey: 'activity.activityBands.bandLight' },
  { band: 'moderate', token: 'activityModerate', nameKey: 'activity.activityBands.bandModerate' },
  { band: 'vigorous', token: 'activityVigorous', nameKey: 'activity.activityBands.bandVigorous' },
]

// A band's points: its weeks on 3 months and Year, its days otherwise.
const pointsOf = (figure: PeriodFigure) => figure.weekly ?? figure.daily

/** Whether any band has a value to draw; the card is left out otherwise. */
export function hasIntensity(intensity: ActivityPeriodData['intensity']): boolean {
  return Object.values(intensity).some((figure) => figure !== null && figure.value !== null)
}

/**
 * "Actieve minuten per intensiteit": each day's light, moderate and vigorous minutes as one stacked
 * bar in the activity tokens' three steps (on 3 months and Year each week's, as the server sends
 * them: a day's average over that week, and the caption says so), the x axis in the range's own
 * words, and under it a legend with each band's period total and a caption saying what a bar is.
 */
export function ActivityIntensity({ intensity, range }: { intensity: ActivityPeriodData['intensity'], range: PeriodRange }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const legendId = useId()
  const present = useMemo(() => BANDS.flatMap(({ band, token, nameKey }) => {
    const figure = intensity[band]
    return figure === null || figure.value === null ? [] : [{ band, token, nameKey, figure }]
  }), [intensity])
  const labels = useMemo(() => (present[0] === undefined ? [] : pointsOf(present[0].figure).map((point) => point.from)), [present])
  const axis = useMemo(() => periodAxisLabels(labels, range, language), [labels, range, language])
  const series = useMemo<BandSeries[]>(() => present.map(({ token, nameKey, figure }) => ({
    key: figure.metric, name: t(nameKey), token, values: pointsOf(figure).map((point) => point.value),
  })), [present, t])
  if (present.length === 0) return null

  const label = t('activity.activityBands.label')
  const weekly = present[0]!.figure.weekly !== null
  return (
    <Card span={12} label={label}>
      <BasisContext.Provider value={legendId}>
        <StackedDailyBars series={series} labels={labels} label={label} unit={t('activity.units.minutes')}
          axisUnit={t('activity.units.min')} metric="active_minutes_light" axis={axis} />
      </BasisContext.Provider>
      <ul className="detail-legend" id={legendId}>
        {present.map(({ band, nameKey, figure }) => (
          <li key={band}><span className="detail-legend-key" data-activity={band} aria-hidden="true" />{t(nameKey)} {minutesCount(figure.total, language, t)}</li>
        ))}
      </ul>
      <p className="dash-caption">
        {weekly ? t('activity.period.intensity.weekly') : t('activity.period.intensity.daily', { period: thisPeriod(range, t) })}
      </p>
    </Card>
  )
}
