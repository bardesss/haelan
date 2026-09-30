import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { verdictTone } from '../../../components/FigureRow.js'
import { ZoneBar, SESSION_ZONE_KEYS } from '../../../charts/ZoneBar.js'
import type { ZoneRow } from '../../../charts/ZoneBar.js'
import type { ActivityPeriodData, PeriodFigure, PeriodRange } from '../../../data/periodTypes.js'
import { asPrinted, periodValueLine, periodVerdictLine, thisPeriod } from '../../detail/periodText.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { minutesText, useActivityLabel } from './labels.js'

const SEPARATOR = ' · '

/** The zones with a period total, light to peak. */
export function heartZoneRows(zones: ActivityPeriodData['heartRateZones'], zoneLabel: (zone: ZoneRow['zone']) => string): ZoneRow[] {
  return SESSION_ZONE_KEYS.flatMap((zone) => {
    const total = zones[zone]?.total ?? null
    return total === null ? [] : [{ zone, label: zoneLabel(zone), minutes: total }]
  })
}

/** Whether the card has anything to show: a zone's time or the day's highest heart rate; it is left out otherwise. */
export function hasHeartZones(zones: ActivityPeriodData['heartRateZones'], maxHeartRate: PeriodFigure | null): boolean {
  return heartZoneRows(zones, () => '').length > 0 || (maxHeartRate !== null && maxHeartRate.value !== null)
}

/**
 * "Hartslagzones", the approved mockup's card beside the zone minutes: the period's time in the top
 * two zones in display type (the server's `hard`, its total), named "intensief of piek" (the workout
 * page's term) with its verdict against the usual for a period's total; then the period's time in each
 * of the four zones as one bar in the zones' own colours (the workout page's ZoneBar), a legend naming
 * each zone's time, the day's highest heart rate as a figure row against its usual, and a caption
 * saying where the time comes from.
 */
export function ActivityHeartZones({ zones, maxHeartRate, range, span }: {
  zones: ActivityPeriodData['heartRateZones']
  maxHeartRate: PeriodFigure | null
  range: PeriodRange
  span: number
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const legendId = useId()
  const labelOf = useActivityLabel()
  // Memoised: the rows reach ZoneBar's build, and a fresh array every render would rebuild its chart.
  const rows = useMemo(() => heartZoneRows(zones, (zone) => t(`activity.workout.zones.${zone}`)), [zones, t])
  // Memoised: PeriodFigureRows memoises on it.
  const figures = useMemo(() => (maxHeartRate === null ? [] : [maxHeartRate]), [maxHeartRate])
  if (!hasHeartZones(zones, maxHeartRate)) return null

  const label = t('activity.workout.page.zones.label')
  const { hard } = zones
  const lead = hard === null || hard.value === null ? null : periodValueLine(hard, language, t).value
  const verdict = hard === null ? null : periodVerdictLine(hard, language, t)
  const judged = hard === null ? null : asPrinted(hard)
  const tone = judged === null ? null : verdictTone(judged.judged, judged.standing)
  return (
    <Card span={span} label={label}>
      {lead !== null && (
        <div className="activity-card-lead">
          <div className="dash-headline">{lead}</div>
          <p className="workout-hero-line">
            {t('activity.period.zones.hard')}
            {verdict !== null && <>{SEPARATOR}<span className={tone === null ? 'detail-verdict' : `detail-verdict ${tone}`}>{verdict}</span></>}
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <BasisContext.Provider value={legendId}>
            <ZoneBar rows={rows} label={label} distinct />
          </BasisContext.Provider>
          <ul className="detail-legend" id={legendId}>
            {rows.map((row) => (
              <li key={row.zone}>
                <span className="detail-legend-key" data-zone={row.zone} aria-hidden="true" />
                {row.label} {minutesText(row.minutes, language, t)}
              </li>
            ))}
          </ul>
        </>
      )}
      <PeriodFigureRows figures={figures} labelOf={labelOf} noun="day" bars max={2} />
      <p className="dash-caption">{t('activity.period.zones.caption', { period: thisPeriod(range, t) })}</p>
    </Card>
  )
}
