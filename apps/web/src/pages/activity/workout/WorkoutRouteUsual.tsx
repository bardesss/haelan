import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRows } from '../../../components/FigureRow.js'
import { Link } from '../../../router.js'
import { formatShortDate } from '../../../format.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { workoutStripOf } from '../../detail/figureText.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'
import { workoutPath } from './workoutText.js'

/**
 * "This route" (the mockup's "Deze route"), beside the fastest efforts under the route card: this
 * workout's time against the earlier times on the same route, as the server matched and judged
 * it (workoutPage.ts's sameRouteOf). The row is labelled from the key the time was compared on,
 * moving or elapsed, and its verdict worded slower or faster, since less time on the same course
 * is the quicker run. The strip draws the latest times on the route, a lower one higher as the
 * hero draws a pace, each dot opening its workout; then a way to the latest earlier one.
 *
 * Left out when the server sends no same route: no route, or no earlier workout on it. The
 * approved mockup also names the route and its length, draws a pace row beside the time and says
 * how many times since when; the payload carries none of those, so none is drawn.
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
  const { time, previous, count } = same
  // Counted off the strip itself, which holds the latest times only, never off `count`.
  const drawn = workoutStripOf(time)
  const caption = [
    ...(drawn === null ? [] : [t('activity.workout.page.sameRoute.strip', { count: drawn.values.length - 1 })]),
    t('activity.workout.page.sameRoute.matched'),
    ...(drawn === null ? [] : [t('activity.workout.page.higherFaster')]),
    ...(drawn?.bands !== undefined ? [t('activity.workout.page.stripBand')] : []),
  ].join(' · ')
  return (
    <Card span={span} label={t('activity.workout.page.sameRoute.label')}>
      <p className="detail-side-caption">{t('activity.workout.page.sameRoute.count', { count })}</p>
      <FigureRows>
        <WorkoutFigureRow figure={time} label={t(`activity.workout.page.figures.${time.key}`)} withStrip words="pace" inverse
          opens={{ current: page.sessionId, onOpen: onOpenWorkout }} />
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
