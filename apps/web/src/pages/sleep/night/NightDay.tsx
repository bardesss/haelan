import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow } from '../../../components/FigureRow.js'
import { Link } from '../../../router.js'
import { workoutPath } from '../../activity/workout/workoutText.js'
import { formatLongDate } from '../../dashboard/glanceText.js'
import { formatNumber } from '../../../format.js'
import { kindLabel } from '../../../data/eventKinds.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
import { MoodFace } from '../../../components/logPanel/MoodFaces.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureValue, verdictLine } from '../../detail/figureText.js'

/**
 * The day before the night (M10a-2 task 7, the mockup's "Die dag"): how it felt, what was tapped
 * and written down through the quick log, and its steps, active minutes and workouts, all read
 * off `page.day` and `page.log` rather than computed here - the same "server judges, page draws"
 * split every figure on this page already keeps.
 *
 * `page.log` is the log for `page.day.localDate`, not for the night's own date: a night is filed
 * under the morning it ends on, and the log it draws here is for the evening before it, which
 * `routes/v1/detail.ts` already resolves before this card ever sees the payload.
 *
 * Hides entirely when the day has nothing to show: no mood, no chips, no note, no steps or active
 * minutes reading, and no workout - the same closing-up rule every other section of this page
 * keeps for a night with a gap in it.
 */
export function NightDay({ day, log }: { day: NightPageData['day'], log: NightPageData['log'] }): ReactNode {
  const { t, i18n } = useTranslation()
  const language = i18n.language

  const chips = Object.entries(log.counts).filter(([, count]) => count > 0)
  const hasLog = log.mood !== null || chips.length > 0 || log.note !== null
  const hasFigures = day.steps.value !== null || day.activeMinutes.value !== null
  if (!hasLog && !hasFigures && day.workouts.length === 0) return null

  const subtitle = t('sleep.night.day.subtitle', { date: formatLongDate(day.localDate, language) })

  return (
    <Card span={12} label={t('sleep.night.day.label')} basis={subtitle}>
      {hasLog && (
        <div className="night-day-top">
          {log.mood !== null && (
            <div className="night-day-mood">
              <MoodFace score={log.mood} />
              <span className="night-day-mood-word">{t(`logPanel.mood.${log.mood}`)}</span>
            </div>
          )}
          {chips.length > 0 && (
            <ul className="night-day-chips">
              {chips.map(([kind, count]) => (
                <li key={kind} className="night-day-chip">
                  {count > 1 ? t('sleep.night.day.chipCount', { kind: kindLabel(t, kind), count }) : kindLabel(t, kind)}
                </li>
              ))}
            </ul>
          )}
          {log.note !== null && <p className="night-day-note">{t('sleep.night.day.note', { note: log.note })}</p>}
        </div>
      )}
      {(hasFigures || day.workouts.length > 0) && (
        <div className="night-day-figures">
          {day.steps.value !== null && (
            <FigureRow label={t('sleep.night.day.steps')} value={formatFigureValue(day.steps, day.steps.value, language, t)}
              verdict={verdictLine(day.steps, language, t) ?? t('glance.usual.none')}
              judged={day.steps.judged} band={day.steps.baseline} mark={day.steps.value} />
          )}
          {day.activeMinutes.value !== null && (
            <FigureRow label={t('sleep.night.day.activeMinutes')} value={formatFigureValue(day.activeMinutes, day.activeMinutes.value, language, t)}
              verdict={verdictLine(day.activeMinutes, language, t) ?? t('glance.usual.none')}
              judged={day.activeMinutes.judged} band={day.activeMinutes.baseline} mark={day.activeMinutes.value} />
          )}
          {day.workouts.length > 0 && (
            <div className="figure-row">
              <span className="figure-row-label">{t('sleep.night.day.workouts')}</span>
              <ul className="night-day-workouts">
                {day.workouts.map((session) => {
                  const summary = workoutSummary(session.attrs)
                  const minutes = Math.round((session.endMs - session.startMs) / 60_000)
                  const duration = `${formatNumber(minutes, 0, language, '0')} ${t('activity.units.min')}`
                  return (
                    <li key={session.id}>
                      <Link to={workoutPath(session.id)} className="figure-row-value night-day-workout-link">
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
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
