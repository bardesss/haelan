import { useTranslation } from '../../i18n/index.js'
import { formatSessionDateHeading } from '../../format.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import type { WorkoutSession } from '../../data/useSessions.js'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { useSourceNames } from '../../data/useSourceNames.js'

/** The clock at both ends of the session, in the reader's own configured zone rather than the
 *  browser's: the same rule timeOfDay in IntradayHeartRate.tsx states, for the same reason. */
function clock(utcMs: number, timeZone: string, language: string): string {
  return new Date(utcMs).toLocaleTimeString(language, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  })
}

/**
 * displayName when present, the exercise type when it is not, the date and both clock times, the
 * source that recorded it, an excluded badge with its reason, and the one sentence about the
 * route this API does not return when the session says a GPS track exists. Everything else the
 * design's section 3 describes for this page (stat tiles, zones, the heart rate trace, splits, the
 * comparison card) is a later task's card, added inside WorkoutDetail's own `.grid` below this.
 */
export function WorkoutHeader({ session, detail, timezone }: {
  session: WorkoutSession
  detail: WorkoutDetail
  timezone: string
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { nameOf } = useSourceNames()
  const summary = workoutSummary(session.attrs)
  // displayName when the provider sent one, the exercise type when it did not. Never both: the
  // name is what the person called this workout, and repeating the type beside it says the same
  // thing twice on the 197 of 197 sessions that carry a displayName.
  const title = detail.displayName ?? exerciseTypeLabel(t, summary.exerciseType)

  return (
    <header className="workout-header">
      <h1 className="workout-title">{title}</h1>
      <p className="workout-when">
        {t('activity.workout.when', {
          date: formatSessionDateHeading(session.localDate, language),
          start: clock(session.startMs, timezone, language),
          end: clock(session.endMs, timezone, language),
          source: nameOf(session.sourceId),
        })}
      </p>
      {session.excluded && (
        <p className="workout-excluded">
          {session.excludeReason !== null
            ? t('activity.sessions.excluded', { reason: session.excludeReason })
            : t('activity.sessions.excludedNoReason')}
        </p>
      )}
      {/* `basis` alongside `workout-gps`: the design's own "Basis line" paragraph puts this
          sentence in the existing `.basis` style, the same treatment every stat tile's basis line
          gets, plus workout-gps's own margin reset since this line sits directly under the
          excluded badge rather than under a tile's value. */}
      {detail.hasGps && <p className="workout-gps basis">{t('activity.workout.gps')}</p>}
    </header>
  )
}
