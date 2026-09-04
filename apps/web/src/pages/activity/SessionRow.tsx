import { useTranslation } from '../../i18n/index.js'
import { formatNumber } from '../../format.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { workoutSummary } from '../../data/workoutSummary.js'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'

/**
 * mm:ss per kilometre, the shape a pace reads as rather than a plain decimal (378.5 seconds
 * reads as "6:19 /km", not "6.3"). The minutes half still goes through formatNumber so it group
 * separates like every other count here if a pace is ever slow enough to reach three digits; the
 * seconds half is a clock position rather than a quantity, zero padded the same way formatClock's
 * own seconds half is in format.ts, not run through Intl a second time for the same reason that one
 * is not.
 */
function formatPace(secondsPerKm: number, language: string): string {
  const totalSeconds = Math.round(secondsPerKm)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${formatNumber(minutes, 0, language, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Two lines, not a fixed column table: only 97 of 192 real sessions carry a distance and 77 a
 * pace, so a Distance column would be blank for half the list, and this project's convention
 * forbids a blank cell that reads as a recorded zero. The first line is what nearly every session
 * has (date, type, duration, and calories and heart rate when the device recorded them); the
 * second carries only the fields THIS session has, built as an array and joined so a field the
 * session never recorded is left out of the sentence rather than printed as an empty slot.
 *
 * `session-row` on the root is load bearing beyond this file: the next task's list counts rows
 * with `container.querySelectorAll('.session-row')`, so it has to be there even though nothing in
 * this file's own tests reads it back.
 *
 * Every field is tested with `!== null`, never truthiness: workoutSummary already turns an
 * unrecorded field into null and a recorded zero into 0, and a `value ? ... : null` guard here
 * would undo that distinction right before it reaches a reader, which is the one thing this
 * component exists to not do.
 */
export function SessionRow({ session }: { session: WorkoutSession }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const summary = workoutSummary(session.attrs)

  // Anchored at UTC midnight and read back in UTC, the same device formatLocalDate uses in
  // format.ts, so the day this prints does not depend on which zone the browser happens to sit in.
  const dateText = new Date(`${session.localDate}T00:00:00Z`).toLocaleString(language, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
  const typeText = exerciseTypeLabel(t, summary.exerciseType)
  // Not read off metricsSummary: every session has a start and an end, so a duration derived from
  // them is never one of the fields this row has to omit.
  const durationMinutes = Math.round((session.endMs - session.startMs) / 60_000)
  const durationText = `${formatNumber(durationMinutes, 0, language, '0')} ${t('activity.units.min')}`

  const stats = [
    summary.caloriesKcal === null ? null
      : `${formatNumber(summary.caloriesKcal, 0, language, '')} ${t('activity.units.kcalShort')}`,
    summary.averageHeartRateBpm === null ? null
      : `${formatNumber(summary.averageHeartRateBpm, 0, language, '')} ${t('activity.units.bpm')}`,
  ].filter((part): part is string => part !== null)

  const detail = [
    summary.distanceMeters === null ? null
      : `${formatNumber(summary.distanceMeters / 1000, 1, language, '')} ${t('activity.units.km')}`,
    summary.paceSecondsPerKm === null ? null
      : `${formatPace(summary.paceSecondsPerKm, language)} ${t('activity.units.paceSuffix')}`,
    summary.elevationGainMeters === null ? null
      : `${formatNumber(summary.elevationGainMeters, 0, language, '')} ${t('activity.units.elevationGainShort')}`,
    summary.steps === null ? null
      : `${formatNumber(summary.steps, 0, language, '')} ${t('activity.units.stepsShort')}`,
    summary.activeZoneMinutes === null ? null
      : `${formatNumber(summary.activeZoneMinutes, 0, language, '')} ${t('activity.units.activeZoneMinutesShort')}`,
  ].filter((part): part is string => part !== null)

  return (
    <div className="session-row">
      <div className="session-row-main">
        <span className="session-row-primary">{[dateText, typeText, durationText].join(' - ')}</span>
        {stats.length > 0 && <span className="session-row-stats">{stats.join(' - ')}</span>}
      </div>
      {/* Omitted outright, not rendered empty: the fourth test pins a session with none of these
          fields to one line, and an empty div here would still be a second line, just a blank one. */}
      {detail.length > 0 && <div className="session-row-detail">{detail.join(' - ')}</div>}
    </div>
  )
}
