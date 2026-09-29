import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { FigureRows } from '../../../components/FigureRow.js'
import { Link } from '../../../router.js'
import type { GlanceFigure } from '../../../data/useGlance.js'
import type { PageFigure } from '../../../data/useNightPage.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { nightPath } from '../../sleep/NightRow.js'
import { SideCard } from '../../detail/DayLogBlock.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * The recovery index as a row's figure: the glance figure the server sent, its value, usual,
 * standing and verdict carried over unchanged, in the shape FigureRow's formatters read. A whole
 * number with no unit, as the dashboard prints it.
 */
function indexFigure(index: GlanceFigure): PageFigure {
  return {
    metric: index.metric, value: index.value, unit: 'count', precision: 0, direction: 'up',
    baseline: index.baseline, standing: index.standing, judged: index.judged, strip: null,
  }
}

/** Whether the card has a row to draw: WorkoutDetail reads it to set this card and Daarna side by side. */
export function hasBefore(page: WorkoutPageData): boolean {
  const { night, recovery, restingHeartRate } = page.before
  // The server sends the recovery and the resting heart rate as null when they have no value.
  return (night !== null && night.asleep.value !== null) || recovery !== null || restingHeartRate !== null
}

/**
 * Before (the mockup's "Daarvoor"), in the shared side layout (SideCard): the night that ended on
 * the workout's own date, the recovery index that morning and its resting heart rate, each against
 * its usual, and a `.card-link` to that night's own page. Which night is the server's pairing
 * (`page.before`). The approved mockup draws time asleep, the index and resting heart rate, not
 * deep sleep, so the night's deep sleep is sent and not drawn. Absent when none has a value.
 */
export function WorkoutBefore({ page, span }: { page: WorkoutPageData, span: 6 | 12 }): ReactNode {
  const { t } = useTranslation()
  if (!hasBefore(page)) return null
  const { night, recovery, restingHeartRate } = page.before
  return (
    <SideCard label={t('activity.workout.page.before.label')} caption={t('activity.workout.page.before.caption')} span={span}>
      <FigureRows side>
        {night !== null && night.asleep.value !== null && <WorkoutFigureRow figure={night.asleep} label={t('activity.workout.page.before.asleep')} />}
        {recovery !== null && <WorkoutFigureRow figure={indexFigure(recovery.index)} label={t('activity.workout.page.before.recoveryIndex')} />}
        {restingHeartRate !== null && <WorkoutFigureRow figure={restingHeartRate} label={t('activity.workout.page.before.restingHeartRate')} />}
      </FigureRows>
      {night !== null && <Link to={nightPath(night.localDate)} className="card-link">{t('activity.workout.page.before.night')}</Link>}
    </SideCard>
  )
}
