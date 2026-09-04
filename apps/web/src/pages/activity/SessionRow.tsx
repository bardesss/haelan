import { useTranslation } from '../../i18n/index.js'
import { formatNumber, formatSessionDateHeading } from '../../format.js'
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
 * has (type and duration, and calories and heart rate when the device recorded them); the second
 * carries only the fields THIS session has, built as an array and joined so a field the session
 * never recorded is left out of the sentence rather than printed as an empty slot.
 *
 * The date is not on that first line: SessionList groups rows by localDate and prints the date
 * once as a heading above each run of same-day rows, so a row repeating it would say it twice. It
 * still names its own date, in the `sr-only` span below, because a screen reader landing on one
 * row by arrow-key browsing has no guarantee it heard the heading first.
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

  // The same call SessionList's own heading makes for this session's group, reused here rather
  // than reformatted, so the sr-only date below can never read a different day than the heading
  // a sighted reader sees above it.
  const dateHeading = formatSessionDateHeading(session.localDate, language)
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

  // Distance, pace and elevation gain only. workoutSummary also carries steps and
  // activeZoneMinutes, but activeZoneMinutes alone covers 167 of 192 sessions, which would make
  // this line a routine five figures on the common case rather than the one to three the two line
  // design was scoped for. Steps on a run restates distance and active zone minutes restates the
  // heart rate already on the first line, so leaving both off keeps this line reserved for what a
  // reader actually came to a workout row to see (fix round 1 review).
  const detail = [
    summary.distanceMeters === null ? null
      : `${formatNumber(summary.distanceMeters / 1000, 1, language, '')} ${t('activity.units.km')}`,
    summary.paceSecondsPerKm === null ? null
      : `${formatPace(summary.paceSecondsPerKm, language)} ${t('activity.units.paceSuffix')}`,
    summary.elevationGainMeters === null ? null
      : `${formatNumber(summary.elevationGainMeters, 0, language, '')} ${t('activity.units.elevationGainShort')}`,
  ].filter((part): part is string => part !== null)

  return (
    <div className="session-row">
      <div className="session-row-main">
        <span className="session-row-primary">
          {/* Trailing space: this text node sits directly against session-row-type's own text
              node with nothing between them in the accessibility tree, and without it a screen
              reader concatenates the two into one word ("augustusCardiotraining"). */}
          <span className="sr-only">{`${dateHeading} `}</span>
          <span className="session-row-type">{typeText}</span>
          <span className="session-row-duration">{durationText}</span>
        </span>
        {stats.length > 0 && <span className="session-row-stats">{stats.join(' - ')}</span>}
      </div>
      {/* Omitted outright, not rendered empty: the fourth test pins a session with none of these
          fields to one line, and an empty div here would still be a second line, just a blank one. */}
      {detail.length > 0 && <div className="session-row-detail">{detail.join(' - ')}</div>}
    </div>
  )
}
