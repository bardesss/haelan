import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { ZoneBar, SESSION_ZONE_KEYS } from '../../../charts/ZoneBar.js'
import type { ZoneRow } from '../../../charts/ZoneBar.js'
import type { ActivityPeriodData, PeriodRange } from '../../../data/periodTypes.js'
import { thisPeriod } from '../../detail/periodText.js'
import { minutesText } from './labels.js'

/** The zones with a period total, light to peak; the card is left out without one. */
export function heartZoneRows(zones: ActivityPeriodData['heartRateZones'], zoneLabel: (zone: ZoneRow['zone']) => string): ZoneRow[] {
  return SESSION_ZONE_KEYS.flatMap((zone) => {
    const total = zones[zone]?.total ?? null
    return total === null ? [] : [{ zone, label: zoneLabel(zone), minutes: total }]
  })
}

/**
 * "Hartslagzones", the approved mockup's card beside the zone minutes: the time in the top two
 * zones over the period in display type ("intensief of piek", the workout page's term), then the
 * period's time in each of the four zones as one bar in the zones' own colours (the workout page's
 * ZoneBar), a legend naming each zone's time, and a caption saying where the time comes from.
 */
export function ActivityHeartZones({ zones, range, span }: { zones: ActivityPeriodData['heartRateZones'], range: PeriodRange, span: number }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const legendId = useId()
  // Memoised: the rows reach ZoneBar's build, and a fresh array every render would rebuild its chart.
  const rows = useMemo(() => heartZoneRows(zones, (zone) => t(`activity.workout.zones.${zone}`)), [zones, t])
  if (rows.length === 0) return null

  const label = t('activity.workout.page.zones.label')
  const hard = rows.filter((row) => row.zone === 'vigorous' || row.zone === 'peak')
  return (
    <Card span={span} label={label}>
      {hard.length > 0 && (
        <div className="activity-card-lead">
          <div className="dash-headline">{minutesText(hard.reduce((sum, row) => sum + row.minutes, 0), language, t)}</div>
          <p className="workout-hero-line">{t('activity.period.zones.hard')}</p>
        </div>
      )}
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
      <p className="dash-caption">{t('activity.period.zones.caption', { period: thisPeriod(range, t) })}</p>
    </Card>
  )
}
