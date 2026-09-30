import { useCallback, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure } from '../../../data/periodTypes.js'
import { periodValueLine } from '../../detail/periodText.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { ZONE_MINUTES_METRIC } from './ActivityZoneMinutes.js'
import { useActivityLabel } from './labels.js'

const WORKOUT_TIME = 'workout_minutes'

/**
 * "Meer over bewegen": the figures that fit no section above (total calories, climb, workout time,
 * time sedentary), each its average (or, for a total, the period's total) against its usual as a
 * bar with its note: the server sends these with no points to draw. The active zone minutes the
 * server sends among them have a card of their own. Workout time's note is its average per day and
 * the workouts it adds up ("12 workouts", the server's `workoutCount`, the approved mockup's).
 */
export function ActivityMore({ figures, workoutCount }: { figures: PeriodFigure[], workoutCount: number }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const labelOf = useActivityLabel()
  const rows = useMemo(() => figures.filter((figure) => figure.metric !== ZONE_MINUTES_METRIC), [figures])
  const noteOf = useCallback((figure: PeriodFigure) => {
    if (figure.metric !== WORKOUT_TIME) return null
    const { under } = periodValueLine(figure, language, t)
    const count = t('activity.period.workouts.count', { count: workoutCount })
    return under === null ? count : `${under} · ${count}`
  }, [workoutCount, language, t])
  if (!rows.some((figure) => figure.value !== null)) return null
  return (
    <Card span={12} label={t('activity.period.more')}>
      <PeriodFigureRows figures={rows} labelOf={labelOf} noun="day" bars noteOf={noteOf} />
    </Card>
  )
}
