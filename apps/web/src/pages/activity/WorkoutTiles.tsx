import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import type { WorkoutSession } from '../../data/useSessions.js'
import { formatNumber } from '../../format.js'
import { formatPace } from './pace.js'

const SECONDS_PER_MINUTE = 60

/** One tile's worth of facts, or null when this session did not record the field. Built as a list
 *  and filtered rather than as JSX with a guard per tile: the rule this page follows everywhere is
 *  that an unrecorded field produces no element at all, and a list makes that one filter rather
 *  than twelve conditionals that each have to remember it. */
interface Tile { key: string, label: string, value: string, unit?: string, basis: string }

/**
 * Section 3's "Stat tiles" paragraph: elapsed, moving (only when it differs from elapsed),
 * distance, average pace, average speed, calories, average heart rate, elevation gain, steps,
 * active zone minutes, VO2max, and swim lengths with pool length - each present only if recorded.
 *
 * `display: contents` on the wrapper (app.css), not a grid of its own: WorkoutDetail's `.grid` is
 * this page's own twelve-column grid, already holding this section's siblings (zones, the trace,
 * splits, the comparison card, added in later tasks), and a nested grid here would put two grids
 * between a tile and the page. The wrapper still exists, as a plain, unstyled parent, so this
 * section's own tests have a stable selector to query under.
 */
export function WorkoutTiles({ session, detail }: {
  session: WorkoutSession
  detail: WorkoutDetail
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const summary = workoutSummary(session.attrs)

  const elapsedMinutes = Math.round((session.endMs - session.startMs) / 60_000)
  const movingMinutes = detail.activeDurationSeconds === null
    ? null
    : Math.round(detail.activeDurationSeconds / SECONDS_PER_MINUTE)

  const n = (value: number, precision: number) => formatNumber(value, precision, language, '')

  const tiles: (Tile | null)[] = [
    { key: 'elapsed', label: t('activity.workout.tiles.elapsed'), value: n(elapsedMinutes, 0),
      unit: t('activity.units.min'), basis: t('activity.workout.basis.elapsed') },
    // Only when it differs: when they are equal the second tile is the first tile again. The
    // comparison is on the displayed minutes, not the raw seconds, so a 3,239 second active
    // duration against a 3,240 second span does not produce two tiles reading "54 min".
    movingMinutes === null || movingMinutes === elapsedMinutes ? null
      : { key: 'moving', label: t('activity.workout.tiles.moving'), value: n(movingMinutes, 0),
        unit: t('activity.units.min'), basis: t('activity.workout.basis.moving') },
    summary.distanceMeters === null ? null
      : { key: 'distance', label: t('activity.workout.tiles.distance'),
        value: n(summary.distanceMeters / 1000, 1), unit: t('activity.units.km'),
        basis: t('activity.workout.basis.provider') },
    summary.paceSecondsPerKm === null ? null
      : { key: 'pace', label: t('activity.workout.tiles.pace'),
        value: formatPace(summary.paceSecondsPerKm, language), unit: t('activity.units.paceSuffix'),
        basis: t('activity.workout.basis.provider') },
    detail.averageSpeedMetersPerSecond === null ? null
      : { key: 'speed', label: t('activity.workout.tiles.speed'),
        value: n(detail.averageSpeedMetersPerSecond, 1), unit: t('activity.units.speed'),
        basis: t('activity.workout.basis.provider') },
    summary.caloriesKcal === null ? null
      : { key: 'calories', label: t('activity.workout.tiles.calories'), value: n(summary.caloriesKcal, 0),
        unit: t('activity.units.kcalShort'), basis: t('activity.workout.basis.provider') },
    summary.averageHeartRateBpm === null ? null
      : { key: 'heartRate', label: t('activity.workout.tiles.heartRate'),
        value: n(summary.averageHeartRateBpm, 0), unit: t('activity.units.bpm'),
        basis: t('activity.workout.basis.provider') },
    summary.elevationGainMeters === null ? null
      : { key: 'elevation', label: t('activity.workout.tiles.elevation'),
        value: n(summary.elevationGainMeters, 0), unit: t('activity.units.meters'),
        basis: t('activity.workout.basis.provider') },
    summary.steps === null ? null
      : { key: 'steps', label: t('activity.workout.tiles.steps'), value: n(summary.steps, 0),
        basis: t('activity.workout.basis.provider') },
    summary.activeZoneMinutes === null ? null
      : { key: 'azm', label: t('activity.workout.tiles.activeZoneMinutes'),
        value: n(summary.activeZoneMinutes, 0), unit: t('activity.units.min'),
        basis: t('activity.workout.basis.provider') },
    detail.runVo2Max === null ? null
      : { key: 'vo2max', label: t('activity.workout.tiles.vo2max'), value: n(detail.runVo2Max, 1),
        basis: t('activity.workout.basis.provider') },
    detail.totalSwimLengths === null ? null
      : { key: 'lengths', label: t('activity.workout.tiles.swimLengths'),
        value: n(detail.totalSwimLengths, 0),
        // The pool length belongs in the basis, not in a tile of its own: it says what a length
        // measures, which is a fact about the figure rather than a second figure.
        basis: detail.poolLengthMeters === null
          ? t('activity.workout.basis.provider')
          : t('activity.workout.basis.pool', { meters: n(detail.poolLengthMeters, 0) }) },
  ]

  return (
    <div className="workout-tiles">
      {tiles.filter((tile): tile is Tile => tile !== null).map((tile) => (
        <Card key={tile.key} span={3}>
          <StatTile label={tile.label} value={tile.value} unit={tile.unit} basis={tile.basis} />
        </Card>
      ))}
    </div>
  )
}
