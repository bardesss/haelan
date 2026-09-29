import { useTranslation } from '../../i18n/index.js'
import { formatRecordedClock, formatSessionDateHeading } from '../../format.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import type { RoutePoint, WorkoutSession } from '../../data/useSessions.js'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import { gpsSentenceKey } from './workout/workoutText.js'


// Moved to workout/workoutText.ts with the About fold that now says it (M10a-3); re-exported
// here only until this file goes.
export { gpsSentenceKey }

/**
 * displayName when present, the exercise type when it is not, the date and both clock times, the
 * source that recorded it, an excluded badge with its reason, and one of three sentences about a
 * route (gpsSentenceKey above says which, or none at all). Everything else the design's section 3
 * describes for this page (stat tiles, zones, the heart rate trace, splits, the comparison card) is
 * a later task's card, added inside WorkoutDetail's own `.grid` below this.
 */
export function WorkoutHeader({ session, detail, route }: {
  session: WorkoutSession
  detail: WorkoutDetail
  // Possibly undefined, not trusted as the always-present array WorkoutSessionDetail declares it:
  // WorkoutRoute.tsx's own comment on its `route` prop gives the reason (an older cached response
  // or any shape that predates this deploy can simply be missing the field), and it applies here
  // unchanged - this component has no error boundary either.
  route: readonly RoutePoint[] | undefined
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { nameOf } = useSourceNames()
  const summary = workoutSummary(session.attrs)
  // displayName when the provider sent one, the exercise type when it did not. Never both: the
  // name is what the person called this workout, and repeating the type beside it says the same
  // thing twice on the 197 of 197 sessions that carry a displayName.
  const title = detail.displayName ?? exerciseTypeLabel(t, summary.exerciseType)
  const gpsKey = gpsSentenceKey(detail, (route ?? []).length)
  // The other sources that recorded this workout, by the names the person gave them. The server
  // answers a run the watch and the phone both delivered as one workout (mergedWorkouts.ts), the
  // primary's source already named in the line above; this is the rest, so a reader can see the
  // second copy exists without the list showing the run twice. Filtered on the primary's id rather
  // than sliced off the front, so a response that lists the primary anywhere still reads right.
  const others = (session.sources ?? []).filter((id) => id !== session.sourceId)

  return (
    <header className="workout-header">
      <h1 className="workout-title">{title}</h1>
      <p className="workout-when">
        {t('activity.workout.when', {
          date: formatSessionDateHeading(session.localDate, language),
          // Each end under the offset it was recorded with, not the reader's zone: a run in
          // Amsterdam at 07:00 reads 07:00 from Tokyo, and a flight between the ends keeps both true.
          start: formatRecordedClock(session.startMs, session.startOffsetMinutes),
          end: formatRecordedClock(session.endMs, session.endOffsetMinutes),
          source: nameOf(session.sourceId),
        })}
      </p>
      {others.length > 0 && (
        <p className="workout-also basis">
          {t('activity.workout.alsoRecordedBy', {
            sources: new Intl.ListFormat(language, { type: 'conjunction' }).format(others.map(nameOf)),
          })}
        </p>
      )}
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
          excluded badge rather than under a tile's value. Which of the three sentences (or none)
          is gpsSentenceKey's own call, made once above rather than three times here. */}
      {gpsKey !== null && <p className="workout-gps basis">{t(gpsKey)}</p>}
    </header>
  )
}
