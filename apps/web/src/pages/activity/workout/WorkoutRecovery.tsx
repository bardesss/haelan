import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRows } from '../../../components/FigureRow.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * Heart-rate recovery (the mockup's "Hartslagherstel"), its own card under the zones: how far heart
 * rate fell one and two minutes after the workout ended, each against the usual from the latest
 * workouts of the type. The server reads the falls and judges them; a larger fall is the better
 * one. Each row is left out without its value, the card without either. The approved mockup also
 * draws a strip under each and the two readings a fall is between; the page is sent neither.
 */
export function WorkoutRecovery({ page }: { page: WorkoutPageData }): ReactNode {
  const { t } = useTranslation()
  // Null from the server exactly when neither minute has a value.
  const recovery = page.heartRateRecovery
  if (recovery === null) return null
  const { oneMinute, twoMinutes } = recovery
  return (
    <Card span={12} label={t('activity.workout.page.recovery.label')}>
      <FigureRows>
        {oneMinute.value !== null && <WorkoutFigureRow figure={oneMinute} label={t('activity.workout.page.recovery.oneMinute')} />}
        {twoMinutes.value !== null && <WorkoutFigureRow figure={twoMinutes} label={t('activity.workout.page.recovery.twoMinutes')} />}
      </FigureRows>
      <p className="dash-caption">{t('activity.workout.page.recovery.caption')}</p>
    </Card>
  )
}
