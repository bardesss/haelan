import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { verdictTone } from '../../../components/FigureRow.js'
import type { ChartTokens } from '../../../charts/tokens.js'
import type { ActivityPeriodData, PeriodFigure, PeriodRange } from '../../../data/periodTypes.js'
import { formatFigureValue } from '../../detail/figureText.js'
import { asPrinted, periodValueLine, periodVerdictLine, thisPeriod } from '../../detail/periodText.js'
import { PeriodStackedBars, presentBands } from './PeriodStackedBars.js'
import type { StackedBand } from './PeriodStackedBars.js'

type Zone = 'fatBurn' | 'cardio' | 'peak'
// The approved mockup's blue, amber and red: the heart-rate zones' own moderate, vigorous and peak
// roles, so a zone minute reads in the colour of the zone that earned it.
const ZONES: readonly { band: Zone, token: keyof ChartTokens, nameKey: string }[] = [
  { band: 'fatBurn', token: 'zoneModerate', nameKey: 'activity.activeZoneMinutes.fatBurn' },
  { band: 'cardio', token: 'zoneVigorous', nameKey: 'activity.activeZoneMinutes.cardio' },
  { band: 'peak', token: 'zonePeak', nameKey: 'activity.activeZoneMinutes.peak' },
]

/** The active zone minutes' own figure, which the server sends among `more`. */
export const ZONE_MINUTES_METRIC = 'active_zone_minutes'

/** Whether any zone has a value to draw; the card is left out otherwise. */
export function hasZoneMinutes(zones: ActivityPeriodData['zoneMinutes']): boolean {
  return Object.values(zones).some((figure) => figure !== null && figure.value !== null)
}

/**
 * "Actieve zoneminuten", the approved mockup's card of its own: the period's total in display type
 * with the verdict on it (the server's `active_zone_minutes`: its total against the usual for a
 * period's total, "880 - 1,150 for a month"), the line under the total its average per day, each
 * day's fat burn, cardio and peak minutes as one stacked bar (each week's on 3 months and Year), a
 * legend with each zone's period total (PeriodStackedBars), and a caption.
 */
export function ActivityZoneMinutes({ zones, total, range, span }: {
  zones: ActivityPeriodData['zoneMinutes']
  /** The `active_zone_minutes` figure, or null. */
  total: PeriodFigure | null
  range: PeriodRange
  span: number
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // Memoised: the bars memoise on it, and a fresh array every render would rebuild the chart.
  const bands = useMemo<StackedBand[]>(() => presentBands(ZONES.map((spec) => ({ ...spec, figure: zones[spec.band] })))
    .map(({ band, token, nameKey, figure }) => ({
      band, token, name: t(nameKey), figure, legend: formatFigureValue(figure, figure.total, language, t),
    })), [zones, language, t])
  if (bands.length === 0) return null

  const label = t('activity.activeZoneMinutes.label')
  const weekly = bands[0]!.figure.weekly !== null
  const lead = total === null || total.value === null ? null : periodValueLine(total, language, t)
  const verdict = total === null ? null : periodVerdictLine(total, language, t)
  const judged = total === null ? null : asPrinted(total)
  const tone = judged === null ? null : verdictTone(judged.judged, judged.standing)
  return (
    <Card span={span} label={label}>
      {lead !== null && (
        <div className="activity-card-lead">
          <div className="dash-headline">{lead.value}</div>
          {lead.under !== null && <p className="workout-hero-line">{lead.under}</p>}
          {verdict !== null && <p className={tone === null ? 'detail-verdict' : `detail-verdict ${tone}`}>{verdict}</p>}
        </div>
      )}
      <PeriodStackedBars bands={bands} range={range} label={label} unit={t('activity.units.activeZoneMinutesShort')}
        axisUnit={t('activity.units.activeZoneMinutesShort')} metric="active_zone_minutes_fat_burn" swatch="azm" />
      <p className="dash-caption">
        {weekly ? t('activity.period.zoneMinutes.weekly') : t('activity.period.zoneMinutes.daily', { period: thisPeriod(range, t) })}
      </p>
    </Card>
  )
}
