import { useTranslation } from '../../i18n/index.js'
import { formatSessionDateHeading } from '../../format.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import type { RoutePoint, WorkoutSession } from '../../data/useSessions.js'
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
 * Which of the three sentences about a route belongs under this workout's heading, or null for
 * the fourth case that gets none at all: a provider that said plainly there was nothing to record.
 *
 * Points decide first, regardless of `hasGps`: a session that carried points needs no sourcing
 * argument, the trace is drawn right below in WorkoutRoute.tsx, and a Google session can never
 * reach this branch since the v4 API sends no route to carry (mapSessions.ts's own comment on
 * `route` says so). Only once there are none does `hasGps` speak - true is Google's own claim of a
 * route this API withholds, unchanged from what this sentence has always said.
 *
 * null says nothing, and used to say the wrong thing. `hasGps` is null for EVERY companion
 * session - Health Connect carries no such field, so this is the normal state rather than a signal
 * - which meant a sentence reading "a GPS route may have been recorded, this app was not able to
 * read it" printed under every workout synced from a phone, an indoor yoga session as readily as a
 * run. It was also false by then: the app could not read routes at all when that sentence was
 * written, and now asks for the permission and reads them.
 *
 * What is left in the null case is a workout with no route points, which is overwhelmingly a
 * workout that had no route. The two cases hiding inside it - a route recorded by another app that
 * never shared it, and a household that refused route access - are indistinguishable here, because
 * both reach the server as the same absence. Saying nothing is the honest answer to a question
 * this surface cannot answer; a sentence about GPS under a yoga session is not.
 */
function gpsSentenceKey(hasGps: boolean | null, routePointCount: number): string | null {
  if (routePointCount > 0) return 'activity.workout.gpsDrawn'
  if (hasGps === true) return 'activity.workout.gps'
  return null
}

/**
 * displayName when present, the exercise type when it is not, the date and both clock times, the
 * source that recorded it, an excluded badge with its reason, and one of three sentences about a
 * route (gpsSentenceKey above says which, or none at all). Everything else the design's section 3
 * describes for this page (stat tiles, zones, the heart rate trace, splits, the comparison card) is
 * a later task's card, added inside WorkoutDetail's own `.grid` below this.
 */
export function WorkoutHeader({ session, detail, timezone, route }: {
  session: WorkoutSession
  detail: WorkoutDetail
  timezone: string
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
  const gpsKey = gpsSentenceKey(detail.hasGps, (route ?? []).length)

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
          excluded badge rather than under a tile's value. Which of the three sentences (or none)
          is gpsSentenceKey's own call, made once above rather than three times here. */}
      {gpsKey !== null && <p className="workout-gps basis">{t(gpsKey)}</p>}
    </header>
  )
}
