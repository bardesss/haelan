import { useMemo, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { workoutDetail } from '@haelan/core/workout-summary'
import { useRoute, routeParams, readQuery } from '../router.js'
import { WORKOUT_ROUTE } from '../routes.js'
import { useWorkoutSession } from '../data/useWorkoutSession.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { useSession } from '../auth/session.js'
import { ApiError } from '../api/client.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
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
 * The one-button `.workout-actions` row between the heading and the grid is this page's own
 * control, not ControlRow's: every other page that opens AnnotatePanel does it from a chart click
 * (an `onPointClick` handing back the day or sample the reader clicked), and this page has no such
 * click to hang it off - the target is the session itself, named by the route, not a point on a
 * chart. `annotating` gates the panel the same way `annotateTarget` does on those pages; there is
 * only ever one target here, so a boolean is enough where they need a nullable target object.
 * Task 7 (M8b) is what makes `scope: 'session'` reachable at all - see AnnotatePanel.tsx's own
 * comment on that variant, and useAnnotations.ts's on why writing at this scope also has to
 * invalidate this page's own cached session and intraday window.
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
  const { sources } = useSourceNames()
  const [annotating, setAnnotating] = useState(false)

  // Memoised on query.data itself, not rebuilt by hand on every read: WorkoutTrace's own `marks`
  // and WorkoutZones' own `rows` derive from this object, and useChart keys each chart's own
  // init/dispose effect on values built from them, so a `detail` that changed reference on every
  // render (a bare `workoutDetail(query.data.attrs)` call here did) disposed and reinitialised
  // both of this page's charts on every commit - window focus, opening or closing the annotate
  // panel, and this task's own session-scope invalidation among them. Final review finding.
  const detail = useMemo(
    () => (query.data === undefined ? null : workoutDetail(query.data.attrs)),
    [query.data],
  )

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
  // `detail === null` cannot actually happen once isPending is false (both read query.data), but
  // spelling it out here rather than asserting past it is what lets TypeScript narrow `detail` to
  // non-null for the rest of the function without a bare `!`.
  if (query.isPending || detail === null) {
    return (
      <div className="grid">
        <Card span={12}><Loading /></Card>
      </div>
    )
  }

  // The reader's own choice, when they arrived carrying one; null otherwise. Read from the URL
  // rather than from a control row: this page has none, and useSourceTrace's fallback rule turns
  // on whether the READER chose a source, which only the URL can say here.
  //
  // Routed through resolveSource, like every sibling page (Activity.tsx, Dashboard.tsx, Health.tsx,
  // Recovery.tsx, Sleep.tsx, Weight.tsx): a link can name a source this person does not have, and a
  // source can be removed after a link was made, and both must read as the all-sources view, not as
  // an explicit (and therefore unfalling-back) choice of a device that will never answer. Final
  // review finding - as shipped, an unknown source id suppressed useSourceTrace's fallback rule and
  // made the trace card vanish, which reads as "no heart rate was recorded", the exact false claim
  // that rule exists to prevent.
  const chosenSourceParam = readQuery(route.split('?')[1] ?? '').get('source')
  const resolvedSource = chosenSourceParam === null
    ? ALL_SOURCES
    : resolveSource(chosenSourceParam, [ALL_SOURCES, ...sources.map((s) => s.id)])
  const chosenSource = resolvedSource === ALL_SOURCES ? null : resolvedSource

  return (
    <>
      <WorkoutHeader session={query.data} detail={detail} timezone={timezone} />
      <div className="workout-actions">
        <button type="button" className="button" onClick={() => setAnnotating(true)}>
          {t('activity.workout.annotate')}
        </button>
      </div>
      <div className="grid">
        <WorkoutTiles session={query.data} detail={detail} cardioLoad={query.data.cardioLoad} />
        <WorkoutZones detail={detail} />
        <WorkoutTrace session={query.data} detail={detail} chosenSource={chosenSource} />
        <WorkoutSplits detail={detail} />
        <WorkoutDynamics detail={detail} />
        <WorkoutComparison session={query.data} />
      </div>
      {annotating && (
        <AnnotatePanel
          target={{ scope: 'session', localDate: query.data.localDate, sessionId: query.data.id }}
          onClose={() => setAnnotating(false)}
        />
      )}
    </>
  )
}
