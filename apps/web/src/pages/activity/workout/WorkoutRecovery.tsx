import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRows } from '../../../components/FigureRow.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatFigureRange } from '../../detail/figureText.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * Heart-rate recovery (the mockup's "Hartslagherstel"), its own card under the zones: how far heart
 * rate fell one and two minutes after the workout ended, each against the usual from the latest
 * workouts of the type. The server reads the falls and judges them; a larger fall is the better
 * one. Each row is left out without its value, the card without either. Under each verdict, the
 * two readings the fall is between ("from 146 to 122 bpm"), the minute means the server took it
 * from. The approved mockup also draws a strip under each; the page is sent none.
 */
export function WorkoutRecovery({ page }: { page: WorkoutPageData }): ReactNode {
  const { t, i18n } = useTranslation()
  // Null from the server exactly when neither minute has a value.
  const recovery = page.heartRateRecovery
  if (recovery === null) return null
  const { oneMinute, twoMinutes, readings, history } = recovery
  // The unit once, after the second reading, the way a range is written ("from 146 to 122 bpm").
  const between = (after: number | null) => {
    if (after === null) return undefined
    const { low, high } = formatFigureRange(oneMinute, readings.endBpm, after, i18n.language, t)
    return t('activity.workout.page.recovery.between', { from: low, to: high })
  }
  // The band is named only when a row draws one: a thin usual draws no bar (FigureRow).
  const drawsBand = [oneMinute, twoMinutes].some((f) => f.value !== null && f.baseline !== null && !f.baseline.thin)
  const caption = [t('activity.workout.page.recovery.caption', { count: history }), ...(drawsBand ? [t('activity.workout.page.stripBand')] : [])].join(' · ')
  return (
    <Card span={12} label={t('activity.workout.page.recovery.label')}>
      <FigureRows>
        {oneMinute.value !== null && <WorkoutFigureRow figure={oneMinute} label={t('activity.workout.page.recovery.oneMinute')} note={between(readings.oneMinuteBpm)} />}
        {twoMinutes.value !== null && <WorkoutFigureRow figure={twoMinutes} label={t('activity.workout.page.recovery.twoMinutes')} note={between(readings.twoMinutesBpm)} />}
      </FigureRows>
      <p className="dash-caption">{caption}</p>
    </Card>
  )
}
