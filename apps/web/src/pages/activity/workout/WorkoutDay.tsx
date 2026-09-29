import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatLongDate } from '../../dashboard/glanceText.js'
import { DayLogBlock, DayWorkoutList, hasDayLog } from '../../detail/DayLogBlock.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * The day the workout was done on (the mockup's "Die dag"): its quick log (DayLogBlock, the same
 * block the night page draws), the day's steps and active minutes against their usual, and the
 * day's other workouts linked to their own pages - or "none, only this one", which is worth saying
 * once the card is there at all.
 *
 * `page.log` is already the log for the workout's own date (routes/v1/detail.ts). Absent when the
 * day has nothing: no log, neither figure and no other workout.
 */
export function WorkoutDay({ page }: { page: WorkoutPageData }): ReactNode {
  const { t, i18n } = useTranslation()
  const { day, log } = page
  const hasFigures = day.steps.value !== null || day.activeMinutes.value !== null
  if (!hasDayLog(log) && !hasFigures && day.otherWorkouts.length === 0) return null

  return (
    <Card span={12} label={t('activity.workout.page.day.label')}>
      <div className="workout-side">
        <p className="workout-side-caption">{formatLongDate(page.localDate, i18n.language)}</p>
        <div>
          <DayLogBlock log={log} />
          <div className="workout-side-rows">
            <WorkoutFigureRow figure={day.steps} label={t('activity.workout.page.day.steps')} />
            <WorkoutFigureRow figure={day.activeMinutes} label={t('activity.workout.page.day.activeMinutes')} />
            <div className="figure-row">
              <span className="figure-row-label">{t('activity.workout.page.day.otherWorkouts')}</span>
              {day.otherWorkouts.length > 0
                ? <DayWorkoutList workouts={day.otherWorkouts} />
                : (
                  <>
                    <span className="figure-row-value">{t('activity.workout.page.day.none')}</span>
                    <span className="figure-row-verdict">{t('activity.workout.page.day.onlyThis')}</span>
                  </>
                )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
