import { useTranslation } from '../../i18n/index.js'
import type { HeartRateZoneDurations, WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../components/Card.js'
import { ZoneBar } from '../../charts/ZoneBar.js'
import type { ZoneRow } from '../../charts/ZoneBar.js'
import type { Translate } from '../../format.js'

const SECONDS_PER_MINUTE = 60

/**
 * A session's own four zones, and they are NOT the intraday active-zone-minutes three.
 *
 * A session carries lightTime, moderateTime, vigorousTime and peakTime (decoded here as
 * lightSeconds/moderateSeconds/vigorousSeconds/peakSeconds by workoutDetail). The intraday
 * `active-zone-minutes` data type this app ingests is keyed FAT_BURN, CARDIO and PEAK, from the v4
 * heartRateZone enum: a different set, from a different source, with its own translation keys under
 * `activity.activeZoneMinutesFatBurn`/`Cardio`/`Peak`. Neither is mapped onto the other, here or
 * anywhere. This project has already shipped enum drift that discarded real data; conflating these
 * two is the same mistake waiting to happen.
 */
export const SESSION_ZONE_KEYS = ['light', 'moderate', 'vigorous', 'peak'] as const

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

export function WorkoutZones({ detail }: { detail: WorkoutDetail }) {
  const { t } = useTranslation()
  // Absent entirely, not an empty chart: workoutDetail already answers null for an object carrying
  // no readable zone at all, which is exactly the question being asked here.
  if (detail.zones === null) return null
  const rows = zoneRows(detail.zones, t)
  if (rows.length === 0) return null

  return (
    <Card span={12} label={t('activity.workout.zones.label')} basis={t('activity.workout.zones.basis')}>
      <ZoneBar rows={rows} label={t('activity.workout.zones.label')} />
    </Card>
  )
}
