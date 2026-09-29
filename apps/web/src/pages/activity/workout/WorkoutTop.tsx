import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { formatRecordedClock, formatSessionDateHeading } from '../../../format.js'
import { Link, navigate, readQuery, useRoute, withQuery } from '../../../router.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
import { StepArrows } from '../../../components/StepArrows.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import type { WorkoutSessionDetail } from '../../../data/useSessions.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { workoutPath } from './workoutText.js'

/**
 * The workout page's header row: the type, when it ran and who recorded it, the workout's own
 * note, then ‹ › to the workouts either side and a way back to every workout - the night page's
 * NightTop, for a workout.
 *
 * Titled by the type (the Activity page's own label for it) rather than the provider's name for
 * the session, which is the type again on nearly every workout; a name that says something else
 * ("Morning run") is kept on a line of its own under it rather than dropped. The clock times are
 * each end under the offset it was recorded with, as they always were here: a run in Amsterdam at
 * 07:00 reads 07:00 from Tokyo.
 *
 * Where the arrows go is the payload's `nav`, never computed here: the server knows the
 * neighbouring workouts of any type, in the order they started. A step keeps the reader's
 * `source` from the URL, for the trace below it, as the night page's step does.
 *
 * The other sources, the excluded badge and the route sentence the old header carried live in the
 * About fold at the foot of the page (WorkoutAbout), beside the control that acts on them.
 */
export function WorkoutTop({ page, session, detail }: {
  page: WorkoutPageData
  session: WorkoutSessionDetail
  detail: WorkoutDetail
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { nameOf } = useSourceNames()
  const route = useRoute()
  const source = readQuery(route.split('?')[1] ?? '').get('source')
  const onPick = useCallback((target: string) => {
    navigate(withQuery(workoutPath(target), { source }))
  }, [source])

  const title = exerciseTypeLabel(t, page.exerciseType)
  const name = detail.displayName !== null && detail.displayName.toLocaleLowerCase(language) !== title.toLocaleLowerCase(language)
    ? detail.displayName
    : null

  return (
    <div className="dash-header workout-top">
      <div className="dash-heading workout-heading">
        <h1 className="dash-title">{title}</h1>
        {name !== null && <p className="workout-name">{name}</p>}
        <p className="dash-date workout-when">
          {t('activity.workout.when', {
            date: formatSessionDateHeading(session.localDate, language),
            start: formatRecordedClock(session.startMs, session.startOffsetMinutes),
            end: formatRecordedClock(session.endMs, session.endOffsetMinutes),
            source: nameOf(session.sourceId),
          })}
        </p>
        {detail.notes !== null && detail.notes.trim() !== '' && (
          <p className="workout-note">{t('sleep.night.day.note', { note: detail.notes.trim() })}</p>
        )}
      </div>
      <div className="workout-top-nav">
        <div className="day-nav" role="group" aria-label={t('activity.workout.page.nav')}>
          {/* The live route map pans on the arrow keys; pressed there, they must not also step
              to another workout. */}
          <StepArrows previous={page.nav.previous} next={page.nav.next} onPick={onPick} ignoreKeysInside=".workout-route-map"
            labels={{ previous: t('activity.workout.page.previous'), next: t('activity.workout.page.next') }} />
        </div>
        <Link to="/activity" className="workout-all">{t('activity.workout.page.allWorkouts')}</Link>
      </div>
    </div>
  )
}
