import { useTranslation } from '../../i18n/index.js'
import { formatNumber, formatSessionDateHeading } from '../../format.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { Link } from '../../router.js'
import { formatPace } from './pace.js'

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

  // Struck through and kept, not filtered out: the Activity count above this list already drops
  // an excluded workout at derivation, and the two visibly disagreeing (fewer counted than listed,
  // one struck through) is what lets a reader see what they threw out, rather than wondering why a
  // session they remember is simply gone.
  const rowClassName = session.excluded ? 'session-row session-row-excluded' : 'session-row'

  return (
    // The row's own way into WorkoutDetail (M8b): the whole row is the target, not a link buried
    // inside it, so this wraps the existing body unchanged rather than adding a link somewhere
    // within it.
    <Link to={`/activity/${encodeURIComponent(session.id)}`} className="session-row-link">
      <div className={rowClassName}>
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
        {/* excludeReason can be null even when excluded is true (a person can exclude without
            typing a reason), so this falls back to a bare "Excluded" rather than printing "Excluded:
            " with nothing after the colon. */}
        {session.excluded && (
          <div className="session-row-excluded-reason">
            {session.excludeReason !== null
              ? t('activity.sessions.excluded', { reason: session.excludeReason })
              : t('activity.sessions.excludedNoReason')}
          </div>
        )}
      </div>
    </Link>
  )
}
