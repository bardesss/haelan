import { useTranslation } from '../i18n/index.js'
import { workoutDetail } from '@haelan/core/workout-summary'
import { useRoute, routeParams } from '../router.js'
import { WORKOUT_ROUTE } from '../routes.js'
import { useWorkoutSession } from '../data/useWorkoutSession.js'
import { useSession } from '../auth/session.js'
import { ApiError } from '../api/client.js'
import { WorkoutHeader } from './activity/WorkoutHeader.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { EmptyState } from '../components/EmptyState.js'

/**
 * One workout, everything recorded about it. Reads its own route parameter rather than taking one
 * as a prop: Shell renders `active.element`, a static node, so there is nothing above this page to
 * hand it a parameter.
 *
 * Its three query states are handled here by hand, the way SessionList handles its own, for the
 * same reason: a session carries no metric and no points, so there is no MetricCard to gate on.
 * A 404 is a real answer rather than an error - the id in the URL names no session of this
 * person's, which readSession answers identically for somebody else's id (M8a's own comment on
 * why it is never a 403) - so it reads as an empty state, not a retry.
 *
 * No `.page` or `.workout-page` wrapper: every page in this app returns a fragment, a heading -
 * here, WorkoutHeader rather than a plain `<h1>`, since this page's heading also carries the
 * workout's clock times, its source and its excluded badge - followed by the twelve-column
 * `.grid` the design's later cards (stat tiles, zones, the trace, splits, the comparison card)
 * land in. Notes.tsx is the shortest example of the same shape this page follows.
 */
export function WorkoutDetail() {
  const { t } = useTranslation()
  const route = useRoute()
  const sessionId = routeParams(WORKOUT_ROUTE, route)?.sessionId
  const session = useSession()
  const timezone = session.data?.timezone ?? 'UTC'
  const query = useWorkoutSession(sessionId)

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.kind === 'not_found'
    return notFound
      ? <EmptyState title={t('activity.workout.missingTitle')} detail={t('activity.workout.missingDetail')} />
      : <ErrorState onRetry={() => void query.refetch()} />
  }
  if (query.isPending) return <Loading />

  const detail = workoutDetail(query.data.attrs)

  return (
    <>
      <WorkoutHeader session={query.data} detail={detail} timezone={timezone} />
      {/* Empty until a later task adds this page's first card: kept here rather than introduced
          alongside that card so this task already establishes the shape every sibling page
          follows (Notes.tsx: a heading, then `.grid`) instead of a follow-up task having to
          restructure this return. */}
      <div className="grid" />
    </>
  )
}
