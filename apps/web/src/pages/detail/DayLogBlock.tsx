import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Link } from '../../router.js'
import { formatNumber } from '../../format.js'
import { kindLabel } from '../../data/eventKinds.js'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { MoodFace } from '../../components/logPanel/MoodFaces.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import type { DayLog } from '../../data/useNightPage.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { workoutPath } from '../activity/workout/workoutText.js'

/** Whether a day's quick log has anything to draw: a mood, a chip tapped at least once, or a note. */
export function hasDayLog(log: DayLog): boolean {
  return log.mood !== null || Object.values(log.counts).some((count) => count > 0) || log.note !== null
}

/**
 * A day's quick log as both detail pages draw it (the mockups' "Die dag"): the mood face with its
 * word, a chip for each kind tapped that day (with its count once there is more than one), and the
 * day's note. One component for the night page's day before and the workout page's day of, so the
 * two cannot drift into two spellings of the same log. Nothing at all when the log is empty
 * (hasDayLog), so a caller need not guard it.
 */
export function DayLogBlock({ log }: { log: DayLog }): ReactNode {
  const { t } = useTranslation()
  if (!hasDayLog(log)) return null
  const chips = Object.entries(log.counts).filter(([, count]) => count > 0)
  return (
    <div className="day-log">
      {log.mood !== null && (
        <div className="day-log-mood">
          <MoodFace score={log.mood} />
          <span className="day-log-mood-word">{t(`logPanel.mood.${log.mood}`)}</span>
        </div>
      )}
      {chips.length > 0 && (
        <ul className="day-log-chips">
          {chips.map(([kind, count]) => (
            <li key={kind} className="day-log-chip">
              {count > 1 ? t('sleep.night.day.chipCount', { kind: kindLabel(t, kind), count }) : kindLabel(t, kind)}
            </li>
          ))}
        </ul>
      )}
      {log.note !== null && <p className="day-log-note">{t('sleep.night.day.note', { note: log.note })}</p>}
    </div>
  )
}

/**
 * A day's workouts as links to their own pages: the type and its minutes, with the average heart
 * rate beside it when the provider sent one. The night page lists the day's workouts with it, the
 * workout page the day's other ones.
 */
export function DayWorkoutList({ workouts }: { workouts: readonly WorkoutSession[] }): ReactNode {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  return (
    <ul className="day-workouts">
      {workouts.map((session) => {
        const summary = workoutSummary(session.attrs)
        const minutes = Math.round((session.endMs - session.startMs) / 60_000)
        const duration = `${formatNumber(minutes, 0, language, '0')} ${t('activity.units.min')}`
        return (
          <li key={session.id}>
            <Link to={workoutPath(session.id)} className="figure-row-value day-workout-link">
              {exerciseTypeLabel(t, summary.exerciseType)} {duration}
            </Link>
            {summary.averageHeartRateBpm !== null && (
              <span className="figure-row-verdict">
                {t('sleep.night.day.workoutAverage', { bpm: formatNumber(summary.averageHeartRateBpm, 0, language, '') })}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
