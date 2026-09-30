import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { HeartRateZoneDurations, WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../../components/Card.js'
import { ZoneBar, SESSION_ZONE_KEYS } from '../../../charts/ZoneBar.js'
import type { ZoneRow } from '../../../charts/ZoneBar.js'
import { formatNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatFigureValue, verdictLine } from '../../detail/figureText.js'
import { filledNote } from './workoutText.js'

const SECONDS_PER_MINUTE = 60

/**
 * A session's own four zones, and they are NOT the intraday active-zone-minutes three.
 *
 * A session carries lightTime, moderateTime, vigorousTime and peakTime (decoded as
 * lightSeconds/moderateSeconds/vigorousSeconds/peakSeconds by workoutDetail). The intraday
 * `active-zone-minutes` data type this app ingests is keyed FAT_BURN, CARDIO and PEAK, from the v4
 * heartRateZone enum: a different set, from a different source, with its own translation keys under
 * `activity.activeZoneMinutesFatBurn`/`Cardio`/`Peak`. Neither is mapped onto the other, here or
 * anywhere. This project has already shipped enum drift that discarded real data; conflating these
 * two is the same mistake waiting to happen. (Moved here from the old WorkoutZones.tsx, which
 * re-exports it until it is retired.)
 */
const SECONDS_FIELD: Record<(typeof SESSION_ZONE_KEYS)[number], keyof HeartRateZoneDurations> = {
  light: 'lightSeconds', moderate: 'moderateSeconds', vigorous: 'vigorousSeconds', peak: 'peakSeconds',
}

/** A row per zone the session actually recorded, in light-to-peak order. A zone recorded as zero
 *  keeps its row (the device says the person spent no time there); a zone the session never
 *  recorded has none - presence is `!== null`, never truthiness, so a recorded zero survives. */
export function zoneRows(zones: HeartRateZoneDurations, t: Translate): ZoneRow[] {
  return SESSION_ZONE_KEYS.flatMap((zone) => {
    const seconds = zones[SECONDS_FIELD[zone]]
    if (seconds === null) return []
    return [{ zone, label: t(`activity.workout.zones.${zone}`), minutes: Math.round(seconds / SECONDS_PER_MINUTE) }]
  })
}

/**
 * The heart rate zones card (M10a-3): the time in hard or peak effort in words, against the usual
 * for this type (the server's `hardZoneMinutes` figure, worded by verdictLine), beside one bar in
 * four distinct zone colours and a legend naming each zone's minutes. Absent when the session
 * recorded no zones; the verdict alone is absent when the server sent no hard-zone figure.
 */
export function WorkoutZones({ detail, page }: { detail: WorkoutDetail, page: WorkoutPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // Memoised: the rows reach ZoneBar's build, and a fresh array every render would rebuild its chart.
  const rows = useMemo(() => (detail.zones === null ? [] : zoneRows(detail.zones, t)), [detail.zones, t])
  if (rows.length === 0) return null

  const hard = page.figures.hardZoneMinutes
  const verdict = hard === undefined || hard.value === null ? null : verdictLine(hard, language, t)
  // Zones the phone's samples filled say so, as every filled figure on the page does.
  const filled = filledNote(page, 'hardZoneMinutes', t)
  const label = t('activity.workout.page.zones.label')

  return (
    <Card span={12} label={label}>
      <div className="workout-zones">
        {hard !== undefined && hard.value !== null && (
          <p className="workout-zones-verdict">
            <strong>{t('activity.workout.page.zones.hard', { value: formatFigureValue(hard, hard.value, language, t) })}</strong>
            {verdict !== null && ` · ${verdict}`}
            {filled !== undefined && ` · ${filled}`}
          </p>
        )}
        <div className="workout-zones-bar">
          <ZoneBar rows={rows} label={label} distinct />
          <ul className="detail-legend">
            {rows.map((row) => (
              <li key={row.zone}>
                <span className="detail-legend-key" data-zone={row.zone} aria-hidden="true" />
                {row.label} {formatNumber(row.minutes, 0, language, '')}{'\u00a0'}{t('activity.units.min')}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}
