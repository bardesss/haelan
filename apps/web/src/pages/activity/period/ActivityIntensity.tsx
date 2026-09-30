import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { ChartTokens } from '../../../charts/tokens.js'
import type { ActivityPeriodData, PeriodRange } from '../../../data/periodTypes.js'
import { thisPeriod } from '../../detail/periodText.js'
import { minutesCount } from './labels.js'
import { PeriodStackedBars, presentBands } from './PeriodStackedBars.js'
import type { StackedBand } from './PeriodStackedBars.js'

type Band = 'light' | 'moderate' | 'vigorous'
// Literal keys, one per band, for catalogue-usage.test.ts (the old page's rule for these names).
const BANDS: readonly { band: Band, token: keyof ChartTokens, nameKey: string }[] = [
  { band: 'light', token: 'activityLight', nameKey: 'activity.activityBands.bandLight' },
  { band: 'moderate', token: 'activityModerate', nameKey: 'activity.activityBands.bandModerate' },
  { band: 'vigorous', token: 'activityVigorous', nameKey: 'activity.activityBands.bandVigorous' },
]

/** Whether any band has a value to draw; the card is left out otherwise. */
export function hasIntensity(intensity: ActivityPeriodData['intensity']): boolean {
  return Object.values(intensity).some((figure) => figure !== null && figure.value !== null)
}

/**
 * "Actieve minuten per intensiteit": each day's light, moderate and vigorous minutes as one stacked
 * bar in the activity tokens' three steps (on 3 months and Year each week's, as the server sends
 * them: a day's average over that week, and the caption says so), with each band's period total in
 * the legend (PeriodStackedBars) and a caption saying what a bar is.
 */
export function ActivityIntensity({ intensity, range }: { intensity: ActivityPeriodData['intensity'], range: PeriodRange }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // Memoised: the bars memoise on it, and a fresh array every render would rebuild the chart.
  const bands = useMemo<StackedBand[]>(() => presentBands(BANDS.map((spec) => ({ ...spec, figure: intensity[spec.band] })))
    .map(({ band, token, nameKey, figure }) => ({ band, token, name: t(nameKey), figure, legend: minutesCount(figure.total, language, t) })),
  [intensity, language, t])
  if (bands.length === 0) return null

  const label = t('activity.activityBands.label')
  const weekly = bands[0]!.figure.weekly !== null
  return (
    <Card span={12} label={label}>
      <PeriodStackedBars bands={bands} range={range} label={label} unit={t('activity.units.minutes')}
        axisUnit={t('activity.units.min')} metric="active_minutes_light" swatch="activity" />
      <p className="dash-caption">
        {weekly ? t('activity.period.intensity.weekly') : t('activity.period.intensity.daily', { period: thisPeriod(range, t) })}
      </p>
    </Card>
  )
}
