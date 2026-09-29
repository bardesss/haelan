import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { FigureRows } from '../../../components/FigureRow.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatLongDate } from '../../dashboard/glanceText.js'
import { TodayWorkouts } from '../../dashboard/TodayWorkouts.js'
import { DayLogBlock, SideCard, hasDayLog } from '../../detail/DayLogBlock.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

/**
 * The day the workout was done on (the mockup's "Die dag"), in the detail pages' shared side
 * layout (SideCard), as the night page's day before is: its quick log with the workout's own note
 * quoted beside the day's (DayLogBlock), the day's steps and active minutes against their usual,
 * and the day's other workouts as the dashboard's own rows (TodayWorkouts), which draws nothing on
 * a day with no other workout - the absence needs no row of its own.
 *
 * `page.log` is already the log for the workout's own date (routes/v1/detail.ts). Absent when the
 * day has nothing: no log, no note, neither figure and no other workout.
 */
export function WorkoutDay({ page, note = null }: { page: WorkoutPageData, note?: string | null }): ReactNode {
  const { t, i18n } = useTranslation()
  const { day, log } = page
  const hasNote = note !== null && note.trim() !== ''
  const hasFigures = day.steps.value !== null || day.activeMinutes.value !== null
  if (!hasDayLog(log) && !hasNote && !hasFigures && day.otherWorkouts.length === 0) return null

  return (
    <SideCard label={t('activity.workout.page.day.label')}
      caption={t('activity.workout.page.day.caption', { date: formatLongDate(page.localDate, i18n.language) })}>
      <DayLogBlock log={log} note={note} />
      {hasFigures && (
        <FigureRows side>
          {/* Only rows with a reading: FigureRows counts its children for its columns. */}
          {day.steps.value !== null && <WorkoutFigureRow figure={day.steps} label={t('activity.workout.page.day.steps')} />}
          {day.activeMinutes.value !== null && <WorkoutFigureRow figure={day.activeMinutes} label={t('activity.workout.page.day.activeMinutes')} />}
        </FigureRows>
      )}
      <TodayWorkouts workouts={day.otherWorkouts} label={t('activity.workout.page.day.workouts')} />
    </SideCard>
  )
}
