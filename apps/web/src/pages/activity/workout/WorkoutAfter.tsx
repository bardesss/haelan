import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Link } from '../../../router.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { nightPath } from '../../sleep/NightRow.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * Afterwards (the mockup's "Daarna"): the night after the workout, time asleep and deep sleep each
 * against the usual night, with a way to that night's own page, and the next morning's resting
 * heart rate. Which night and which morning is the server's pairing (`page.after`), never worked
 * out here. Absent when neither the night nor the resting heart rate has a reading.
 */
export function WorkoutAfter({ page }: { page: WorkoutPageData }): ReactNode {
  const { t } = useTranslation()
  const { night, restingHeartRate } = page.after
  const hasNight = night !== null && (night.asleep.value !== null || night.deep.value !== null)
  const hasResting = restingHeartRate !== null && restingHeartRate.value !== null
  if (!hasNight && !hasResting) return null

  return (
    <Card span={12} label={t('activity.workout.page.after.label')}>
      <div className="workout-side">
        <p className="workout-side-caption">{t('activity.workout.page.after.caption')}</p>
        <div className="workout-side-rows">
          {hasNight && (
            <div className="workout-after-cell">
              <WorkoutFigureRow figure={night.asleep} label={t('activity.workout.page.after.asleep')} />
              <Link to={nightPath(night.localDate)} className="workout-after-night">{t('activity.workout.page.after.night')}</Link>
            </div>
          )}
          {hasNight && <WorkoutFigureRow figure={night.deep} label={t('activity.workout.page.after.deep')} />}
          {hasResting && <WorkoutFigureRow figure={restingHeartRate} label={t('activity.workout.page.after.restingHeartRate')} />}
        </div>
      </div>
    </Card>
  )
}
