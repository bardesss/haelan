import { useMemo, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { workoutDetail } from '@haelan/core/workout-summary'
import { useRoute, routeParams, readQuery } from '../router.js'
import { WORKOUT_ROUTE } from '../routes.js'
import { useWorkoutSession } from '../data/useWorkoutSession.js'
import { useWorkoutPage } from '../data/useWorkoutPage.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { ApiError } from '../api/client.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import { WorkoutTop } from './activity/workout/WorkoutTop.js'
import { WorkoutHero } from './activity/workout/WorkoutHero.js'
import { WorkoutMinis } from './activity/workout/WorkoutMinis.js'
import { WorkoutCompared } from './activity/workout/WorkoutCompared.js'
import { WorkoutMap } from './activity/workout/WorkoutMap.js'
import { WorkoutThrough } from './activity/workout/WorkoutThrough.js'
import { WorkoutZones } from './activity/workout/WorkoutZones.js'
import { WorkoutTiles } from './activity/WorkoutTiles.js'
import { WorkoutDynamics } from './activity/WorkoutDynamics.js'
import { Card } from '../components/Card.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { EmptyState } from '../components/EmptyState.js'

/**
 * One workout, everything recorded about it (M10a): the header row, the figure its type is judged
 * by against its usual, the four figures under it and the comparison table, then the sections
 * below. Reads its own route parameter rather than taking one as a prop: Shell renders
 * `active.element`, a static node, so there is nothing above this page to hand it a parameter.
 *
 * Two reads. The workout page (useWorkoutPage) carries every figure already judged against the
 * earlier sessions of the type, the neighbours for ‹ › and the Records best; the session itself
 * (useWorkoutSession, /sessions/:id) still carries what only its attrs and rows hold - the note,
 * the clock times, the route points, the splits, the other copies of a merged workout - and the
 * sections below the new ones still draw from it. The page waits for both, so it never draws a
 * header without its figures or figures under the wrong header.
 *
 * A 404 from either is a real answer rather than an error - the id in the URL names no workout of
 * this person's, which the server answers identically for somebody else's id (M8a's own comment on
 * why it is never a 403) - so it reads as an empty state, not a retry. All three states render
 * inside `<div className="grid"><Card span={12}>...</Card></div>`, since Shell renders straight into
 * `.main`, which carries no card background of its own.
 *
 * The one-button `.workout-actions` row under the header is this page's own control: the annotate
 * target is the session itself, named by the route, not a point on a chart. `annotating` gates the
 * panel the way `annotateTarget` does on the chart pages; there is only ever one target here.
 */
export function WorkoutDetail() {
  const { t } = useTranslation()
  const route = useRoute()
  const sessionId = routeParams(WORKOUT_ROUTE, route)?.sessionId
  const query = useWorkoutSession(sessionId)
  const pageQuery = useWorkoutPage(sessionId)
  const { sources } = useSourceNames()
  const [annotating, setAnnotating] = useState(false)

  // Memoised on query.data itself, not rebuilt by hand on every read: WorkoutThrough's own pauses
  // and WorkoutZones' own `rows` derive from this object, and useChart keys each chart's own
  // init/dispose effect on values built from them, so a `detail` that changed reference on every
  // render disposed and reinitialised both of this page's charts on every commit (M8b's final
  // review finding).
  const detail = useMemo(
    () => (query.data === undefined ? null : workoutDetail(query.data.attrs)),
    [query.data],
  )

  if (query.isError || pageQuery.isError) {
    // The session's own failure first: it is the read the rest of the page has always stood on.
    const failed = query.isError ? query : pageQuery
    const notFound = failed.error instanceof ApiError && failed.error.kind === 'not_found'
    return (
      <div className="grid">
        <Card span={12}>
          {notFound
            ? <EmptyState title={t('activity.workout.missingTitle')} detail={t('activity.workout.missingDetail')} />
            : <ErrorState onRetry={() => void failed.refetch()} error={failed.error} />}
        </Card>
      </div>
    )
  }
  // `detail === null` cannot actually happen once isPending is false (both read query.data), but
  // spelling it out lets TypeScript narrow `detail` for the rest of the function without a `!`.
  if (query.isPending || pageQuery.isPending || detail === null) {
    return (
      <div className="grid">
        <Card span={12}><Loading /></Card>
      </div>
    )
  }

  // The reader's own choice, when they arrived carrying one; null otherwise. Routed through
  // resolveSource like every sibling page: a link can name a source this person does not have, and
  // a source can be removed after a link was made, and both must read as the all-sources view, not
  // as an explicit choice of a device that will never answer (an unknown id used to suppress
  // useSourceTrace's fallback and make the trace card vanish, which reads as "no heart rate").
  const chosenSourceParam = readQuery(route.split('?')[1] ?? '').get('source')
  const resolvedSource = chosenSourceParam === null
    ? ALL_SOURCES
    : resolveSource(chosenSourceParam, [ALL_SOURCES, ...sources.map((s) => s.id)])
  const chosenSource = resolvedSource === ALL_SOURCES ? null : resolvedSource
  const page = pageQuery.data

  return (
    <div className="workout-page">
      <WorkoutTop page={page} session={query.data} detail={detail} />
      <div className="workout-actions">
        <button type="button" className="button" onClick={() => setAnnotating(true)}>
          {t('activity.workout.annotate')}
        </button>
      </div>
      <div className="grid">
        <WorkoutHero page={page} />
        <WorkoutMinis page={page} />
        <WorkoutCompared page={page} />
        <WorkoutMap session={query.data} page={page} />
        <WorkoutThrough session={query.data} detail={detail} page={page} chosenSource={chosenSource} />
        <WorkoutZones detail={detail} page={page} />
        {/* The pre-M10a sections, below the new ones until their redesigned replacements land. */}
        <WorkoutTiles session={query.data} detail={detail} cardioLoad={query.data.cardioLoad} />
        <WorkoutDynamics detail={detail} />
      </div>
      {annotating && (
        <AnnotatePanel
          // query.data.id rather than the URL's own id: an old link can name a copy the server has
          // since merged into another workout, and the answer's id is the one that stands for it.
          target={{
            scope: 'session', localDate: query.data.localDate, sessionId: query.data.id,
            alsoSessionIds: query.data.alternateIds ?? [],
          }}
          onClose={() => setAnnotating(false)}
        />
      )}
    </div>
  )
}
