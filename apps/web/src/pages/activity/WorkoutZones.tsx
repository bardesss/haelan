import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import type { HeartRateZoneDurations, WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../components/Card.js'
import { ZoneBar, SESSION_ZONE_KEYS } from '../../charts/ZoneBar.js'
import type { ZoneRow } from '../../charts/ZoneBar.js'
import type { Translate } from '../../format.js'

const SECONDS_PER_MINUTE = 60

// Re-exported so existing and future imports of the session zone vocabulary keep reading from this
// file, which is where what the zones ARE (and are not) is explained, immediately below. The array
// itself now lives in charts/ZoneBar.js, which is the one place that needs it at runtime for a
// zone's own colour (that file's own comment on why); importing it back here rather than the
// reverse direction avoids a cycle, since this file already imports ZoneBar the component.
export { SESSION_ZONE_KEYS }

/**
 * A session's own four zones, and they are NOT the intraday active-zone-minutes three.
 *
 * A session carries lightTime, moderateTime, vigorousTime and peakTime (decoded here as
 * lightSeconds/moderateSeconds/vigorousSeconds/peakSeconds by workoutDetail). The intraday
 * `active-zone-minutes` data type this app ingests is keyed FAT_BURN, CARDIO and PEAK, from the v4
 * heartRateZone enum: a different set, from a different source, with its own translation keys under
 * `activity.activeZoneMinutesFatBurn`/`Cardio`/`Peak`. Neither is mapped onto the other, here or
 * anywhere. This project has already shipped enum drift that discarded real data; conflating these
 * two is the same mistake waiting to happen. (SESSION_ZONE_KEYS itself: see charts/ZoneBar.js.)
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

export function WorkoutZones({ detail }: { detail: WorkoutDetail }) {
  const { t } = useTranslation()
  // Memoised on detail.zones and t, not rebuilt as a fresh array on every render: this feeds
  // ZoneBar's own `rows` prop, which sits in that chart's `build` useCallback deps, which useChart
  // keys its init/dispose effect on (useChart.ts's own comment on `build`) - a fresh `zoneRows(...)`
  // call here disposed and reinitialised the chart on every commit regardless of whether the zones
  // actually changed. Final review finding, the same shape as WorkoutTrace's own `marks`.
  //
  // Called unconditionally (before the `zones === null` question below) because a hook cannot be
  // called on some renders and not others; zoneRows itself already answers `[]` for `null` input.
  const rows = useMemo(() => (detail.zones === null ? [] : zoneRows(detail.zones, t)), [detail.zones, t])
  // Absent entirely, not an empty chart: workoutDetail already answers null for an object carrying
  // no readable zone at all (rows.length === 0 then too), which is exactly the question being
  // asked here.
  if (rows.length === 0) return null

  return (
    <Card span={12} label={t('activity.workout.zones.label')} basis={t('activity.workout.zones.basis')}>
      <ZoneBar rows={rows} label={t('activity.workout.zones.label')} />
    </Card>
  )
}
