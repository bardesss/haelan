import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { formatRecordedClock, formatSessionDateHeading } from '../../../format.js'
import { navigate, readQuery, useRoute, withQuery } from '../../../router.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
import { DetailNav, PageHeader } from '../../../components/PageHeader.js'
import type { WorkoutSessionDetail } from '../../../data/useSessions.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { workoutPath } from './workoutText.js'

/**
 * Opens another workout's page, keeping the reader's `source` from the URL for the trace below it,
 * as useOpenNight does for a night. The header's arrows and the hero strip's dots both go through this.
 */
export function useOpenWorkout(): (sessionId: string) => void {
  const route = useRoute()
  const source = readQuery(route.split('?')[1] ?? '').get('source')
  return useCallback((target: string) => {
    navigate(withQuery(workoutPath(target), { source }))
  }, [source])
}

/**
 * The workout page's header row, the dashboard's own (PageHeader) as the night page's is: the
 * type, when it ran and who recorded it, then ‹ › to the workouts either side and a way back to
 * every workout (DetailNav).
 *
 * Titled by the type (the Activity page's own label for it) rather than the provider's name for
 * the session, which is the type again on nearly every workout; a name that says something else
 * ("Morning run") is kept in the About fold, and the workout's own note in the day block, since a
 * header carries when and who and nothing else (PATTERNS.md). The clock times are each end under
 * the offset it was recorded with: a run in Amsterdam at 07:00 reads 07:00 from Tokyo.
 *
 * Where the arrows go is the payload's `nav`, never computed here. Without a payload (loading, a
 * missing workout, a failed read) the row is still drawn, with a generic title, the arrows
 * disabled and the way back live, so a missing workout is never a dead end.
 */
export function WorkoutTop({ page, session }: { page?: WorkoutPageData, session?: WorkoutSessionDetail }) {
  const { t, i18n } = useTranslation()
  const { nameOf } = useSourceNames()
  const onPick = useOpenWorkout()

  const title = page === undefined ? t('activity.workout.page.untitled') : exerciseTypeLabel(t, page.exerciseType)
  const line = session === undefined ? undefined : t('activity.workout.when', {
    date: formatSessionDateHeading(session.localDate, i18n.language),
    start: formatRecordedClock(session.startMs, session.startOffsetMinutes),
    end: formatRecordedClock(session.endMs, session.endOffsetMinutes),
    source: nameOf(session.sourceId),
  })
  // The live route map pans on the arrow keys; pressed there, they must not also step to another workout.
  const nav = (
    <DetailNav label={t('activity.workout.page.nav')} previous={page?.nav.previous ?? null} next={page?.nav.next ?? null}
      onPick={onPick} ignoreKeysInside=".workout-route-map"
      labels={{ previous: t('activity.workout.page.previous'), next: t('activity.workout.page.next') }}
      back={{ to: '/activity', text: t('activity.workout.page.allWorkouts') }} />
  )
  return <PageHeader title={title} line={line} nav={nav} />
}
