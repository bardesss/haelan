import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../components/Card.js'
import { ZoneBar, SESSION_ZONE_KEYS } from '../../charts/ZoneBar.js'
import { zoneRows } from './workout/WorkoutZones.js'

// Re-exported so existing and future imports of the session zone vocabulary keep reading from this
// file. The array itself lives in charts/ZoneBar.js, which needs it at runtime for a zone's own
// colour; zoneRows and what the four zones are (and are not) now live beside the workout page's
// new zones card, workout/WorkoutZones.tsx, until this old card is retired.
export { SESSION_ZONE_KEYS, zoneRows }

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
