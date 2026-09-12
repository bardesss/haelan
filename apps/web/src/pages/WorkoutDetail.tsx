import { useTranslation } from '../i18n/index.js'
import { workoutDetail } from '@haelan/core/workout-summary'
import { useRoute, routeParams, readQuery } from '../router.js'
import { WORKOUT_ROUTE } from '../routes.js'
import { useWorkoutSession } from '../data/useWorkoutSession.js'
import { useSession } from '../auth/session.js'
import { ApiError } from '../api/client.js'
import { ALL_SOURCES } from '../controls/source.js'
import { WorkoutHeader } from './activity/WorkoutHeader.js'
import { WorkoutTiles } from './activity/WorkoutTiles.js'
import { WorkoutZones } from './activity/WorkoutZones.js'
import { WorkoutTrace } from './activity/WorkoutTrace.js'
import { WorkoutSplits } from './activity/WorkoutSplits.js'
import { WorkoutDynamics } from './activity/WorkoutDynamics.js'
import { WorkoutComparison } from './activity/WorkoutComparison.js'
import { Card } from '../components/Card.js'
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
 * All three states render inside `<div className="grid"><Card span={12}>...</Card></div>`,
 * Nutrition.tsx's own shape for a whole page that is one card - not SessionList.tsx's, which was
 * the wrong precedent: SessionList's hand-rolled states render inside a `Card` its *caller*
 * (Activity.tsx) already supplies, whereas Shell renders `active.element` straight into `.main`,
 * which carries no card background of its own. Without this a cold load, a slow network or a
 * stale/bad session id in a link showed unstyled floating text - review finding on this task.
 *
 * No `.page` or `.workout-page` wrapper on the loaded state below: every page in this app returns
 * a fragment, a heading - here, WorkoutHeader rather than a plain `<h1>`, since this page's heading
 * also carries the workout's clock times, its source and its excluded badge - followed by the
 * twelve-column `.grid` the design's cards land in: the stat tiles first, then the zone card, the
 * heart rate trace, the splits and running dynamics cards, then the comparison card last.
 * Notes.tsx is the shortest example of the same shape this page follows.
 *
 * WorkoutComparison (unlike WorkoutTrace, which takes the resolved session as a prop but owns its
 * own hook the same way) is mounted only here, inside the grid reached only once `query` has left
 * both isPending and isError below - the guard useWorkoutComparison's own comment names: it is
 * never asked to compare against a session that has not resolved.
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
    return (
      <div className="grid">
        <Card span={12}>
          {notFound
            ? <EmptyState title={t('activity.workout.missingTitle')} detail={t('activity.workout.missingDetail')} />
            : <ErrorState onRetry={() => void query.refetch()} />}
        </Card>
      </div>
    )
  }
  if (query.isPending) {
    return (
      <div className="grid">
        <Card span={12}><Loading /></Card>
      </div>
    )
  }

  const detail = workoutDetail(query.data.attrs)

  // The reader's own choice, when they arrived carrying one; null otherwise. Read from the URL
  // rather than from a control row: this page has none, and useWorkoutTrace's fallback rule turns
  // on whether the READER chose a source, which only the URL can say here.
  const chosenSourceParam = readQuery(route.split('?')[1] ?? '').get('source')
  const chosenSource = chosenSourceParam === null || chosenSourceParam === ALL_SOURCES ? null : chosenSourceParam

  return (
    <>
      <WorkoutHeader session={query.data} detail={detail} timezone={timezone} />
      <div className="grid">
        <WorkoutTiles session={query.data} detail={detail} />
        <WorkoutZones detail={detail} />
        <WorkoutTrace session={query.data} detail={detail} chosenSource={chosenSource} />
        <WorkoutSplits detail={detail} />
        <WorkoutDynamics detail={detail} />
        <WorkoutComparison session={query.data} />
      </div>
    </>
  )
}
