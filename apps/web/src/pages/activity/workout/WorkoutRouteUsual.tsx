import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRows } from '../../../components/FigureRow.js'
import { Link } from '../../../router.js'
import { formatShortDate } from '../../../format.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { workoutStripOf } from '../../detail/figureText.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'
import { bestMonth, filledNote, workoutPath } from './workoutText.js'

/**
 * "This route" (the mockup's "Deze route"), beside the fastest efforts under the route card: how
 * many times the route has been run since the oldest time on it, then this workout's rate (the
 * category's: pace, a ride's speed, a swim's pace per 100 m) and time against the earlier ones on
 * it, as the server matched and judged them (workoutPage.ts's sameRouteOf). The time row is labelled from the key it was compared on, moving or elapsed, and
 * its verdict worded slower or faster, since less time on the same course is the quicker run.
 * Each strip draws the latest readings on the route, a lower time or pace higher as the hero draws
 * a pace (a speed stays the right way up, higher being faster already), each dot opening its
 * workout; then a way to the latest earlier one.
 *
 * Left out when the server sends no same route: no route, or no earlier workout on it; the rate
 * row without a rate. The approved mockup also names the route and its length, and a line under
 * each row; the payload carries none of those, so none is drawn.
 */
export function WorkoutRouteUsual({ page, span, onOpenWorkout }: {
  page: WorkoutPageData
  span: 6 | 12
  /** Opens a strip dot's workout on its own page (useOpenWorkout). */
  onOpenWorkout?: (sessionId: string) => void
}): ReactNode {
  const { t, i18n } = useTranslation()
  const same = page.sameRoute
  if (same === null) return null
  const { time, rate, previous, times, since } = same
  const drawn = [time, ...(rate === null ? [] : [rate])].flatMap((figure) => {
    const strip = workoutStripOf(figure)
    return strip === null ? [] : [strip]
  })
  // The mockup's words, with the upside-down line said as the hero says it and the band named only
  // where one is drawn.
  const caption = [
    ...(drawn.length === 0 ? [] : [t('activity.workout.page.sameRoute.strip')]),
    t('activity.workout.page.sameRoute.matched'),
    ...(drawn.length === 0 ? [] : [t('activity.workout.page.higherFaster')]),
    ...(drawn.some((strip) => strip.bands !== undefined) ? [t('activity.workout.page.stripBand')] : []),
  ].join(' · ')
  const opens = { current: page.sessionId, onOpen: onOpenWorkout }
  return (
    <Card span={span} label={t('activity.workout.page.sameRoute.label')}>
      {/* The server's count, this workout already in it: "6 times on this route since May". */}
      <p className="detail-side-caption workout-route-lead">
        {t('activity.workout.page.sameRoute.count', { count: times, month: bestMonth(since, page.localDate, i18n.language) })}
      </p>
      <FigureRows>
        {rate !== null && (
          <WorkoutFigureRow figure={rate} label={t(`activity.workout.page.figures.${rate.key}`)} withStrip inverse={rate.direction === 'down'} opens={opens}
            note={filledNote(page, rate.key, t)} />
        )}
        <WorkoutFigureRow figure={time} label={t(`activity.workout.page.figures.${time.key}`)} withStrip words="pace" inverse opens={opens} />
      </FigureRows>
      <p className="dash-caption">{caption}</p>
      {previous !== null && (
        <Link to={workoutPath(previous.sessionId)} className="card-link">
          {t('activity.workout.page.sameRoute.view', { date: formatShortDate(previous.localDate, page.localDate, i18n.language) })}
        </Link>
      )}
    </Card>
  )
}
