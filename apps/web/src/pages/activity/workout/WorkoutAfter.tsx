import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { FigureRows } from '../../../components/FigureRow.js'
import { Link } from '../../../router.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { nightPath } from '../../sleep/NightRow.js'
import { SideCard } from '../../detail/DayLogBlock.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * Afterwards (the mockup's "Daarna"), in the shared side layout (SideCard): the night after the
 * workout, time asleep and deep sleep each against the usual night, the next morning's resting
 * heart rate, and a `.card-link` to that night's own page. Which night and which morning is the
 * server's pairing (`page.after`), never worked out here. Absent when neither the night nor the
 * resting heart rate has a reading.
 */
export function WorkoutAfter({ page }: { page: WorkoutPageData }): ReactNode {
  const { t } = useTranslation()
  const { night, restingHeartRate } = page.after
  const hasNight = night !== null && (night.asleep.value !== null || night.deep.value !== null)
  const hasResting = restingHeartRate !== null && restingHeartRate.value !== null
  if (!hasNight && !hasResting) return null

  return (
    <SideCard label={t('activity.workout.page.after.label')} caption={t('activity.workout.page.after.caption')}>
      <FigureRows side>
        {hasNight && night.asleep.value !== null && <WorkoutFigureRow figure={night.asleep} label={t('activity.workout.page.after.asleep')} />}
        {hasNight && night.deep.value !== null && <WorkoutFigureRow figure={night.deep} label={t('activity.workout.page.after.deep')} />}
        {hasResting && <WorkoutFigureRow figure={restingHeartRate} label={t('activity.workout.page.after.restingHeartRate')} />}
      </FigureRows>
      {hasNight && <Link to={nightPath(night.localDate)} className="card-link">{t('activity.workout.page.after.night')}</Link>}
    </SideCard>
  )
}
