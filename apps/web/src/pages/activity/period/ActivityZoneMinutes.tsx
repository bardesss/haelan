import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { verdictTone } from '../../../components/FigureRow.js'
import { StackedDailyBars } from '../../../charts/StackedDailyBars.js'
import type { BandSeries } from '../../../charts/StackedDailyBars.js'
import { periodAxisLabels } from '../../../charts/barAxis.js'
import type { ChartTokens } from '../../../charts/tokens.js'
import type { ActivityPeriodData, PeriodFigure, PeriodRange } from '../../../data/periodTypes.js'
import { formatFigureValue } from '../../detail/figureText.js'
import { asPrinted, periodValueLine, periodVerdictLine, thisPeriod } from '../../detail/periodText.js'

type Zone = 'fatBurn' | 'cardio' | 'peak'
// The approved mockup's blue, amber and red: the heart-rate zones' own moderate, vigorous and peak
// roles, so a zone minute reads in the colour of the zone that earned it.
const ZONES: readonly { zone: Zone, token: keyof ChartTokens, nameKey: string }[] = [
  { zone: 'fatBurn', token: 'zoneModerate', nameKey: 'activity.activeZoneMinutes.fatBurn' },
  { zone: 'cardio', token: 'zoneVigorous', nameKey: 'activity.activeZoneMinutes.cardio' },
  { zone: 'peak', token: 'zonePeak', nameKey: 'activity.activeZoneMinutes.peak' },
]

/** The active zone minutes' own figure, which the server sends among `more`. */
export const ZONE_MINUTES_METRIC = 'active_zone_minutes'

const pointsOf = (figure: PeriodFigure) => figure.weekly ?? figure.daily

/** Whether any zone has a value to draw; the card is left out otherwise. */
export function hasZoneMinutes(zones: ActivityPeriodData['zoneMinutes']): boolean {
  return Object.values(zones).some((figure) => figure !== null && figure.value !== null)
}

/**
 * "Actieve zoneminuten", the approved mockup's card of its own: the period's total in display type
 * with the verdict on it (the server's `active_zone_minutes`: its total against the usual for a
 * period's total, "880 - 1,150 for a month"), the line under the total its average per day, each day's fat burn, cardio and peak minutes as one stacked bar
 * (each week's on 3 months and Year), a legend with each zone's period total, and a caption.
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
  const legendId = useId()
  const present = useMemo(() => ZONES.flatMap(({ zone, token, nameKey }) => {
    const figure = zones[zone]
    return figure === null || figure.value === null ? [] : [{ zone, token, nameKey, figure }]
  }), [zones])
  const labels = useMemo(() => (present[0] === undefined ? [] : pointsOf(present[0].figure).map((point) => point.from)), [present])
  const axis = useMemo(() => periodAxisLabels(labels, range, language), [labels, range, language])
  const series = useMemo<BandSeries[]>(() => present.map(({ token, nameKey, figure }) => ({
    key: figure.metric, name: t(nameKey), token, values: pointsOf(figure).map((point) => point.value),
  })), [present, t])
  if (present.length === 0) return null

  const label = t('activity.activeZoneMinutes.label')
  const weekly = present[0]!.figure.weekly !== null
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
      <BasisContext.Provider value={legendId}>
        <StackedDailyBars series={series} labels={labels} label={label} unit={t('activity.units.activeZoneMinutesShort')}
          axisUnit={t('activity.units.activeZoneMinutesShort')} metric="active_zone_minutes_fat_burn" axis={axis} />
      </BasisContext.Provider>
      <ul className="detail-legend" id={legendId}>
        {present.map(({ zone, nameKey, figure }) => (
          <li key={zone}><span className="detail-legend-key" data-azm={zone} aria-hidden="true" />{t(nameKey)} {formatFigureValue(figure, figure.total, language, t)}</li>
        ))}
      </ul>
      <p className="dash-caption">
        {weekly ? t('activity.period.zoneMinutes.weekly') : t('activity.period.zoneMinutes.daily', { period: thisPeriod(range, t) })}
      </p>
    </Card>
  )
}
