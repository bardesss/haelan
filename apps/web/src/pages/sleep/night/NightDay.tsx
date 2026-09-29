import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow } from '../../../components/FigureRow.js'
import { formatLongDate } from '../../dashboard/glanceText.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureValue, verdictLine } from '../../detail/figureText.js'
import { DayLogBlock, DayWorkoutList, hasDayLog } from '../../detail/DayLogBlock.js'

/**
 * The day before the night (M10a-2 task 7, the mockup's "Die dag"): how it felt, what was tapped
 * and written down through the quick log, and its steps, active minutes and workouts, all read
 * off `page.day` and `page.log` rather than computed here (the log and the workout list are
 * DayLogBlock's, shared with the workout page's own day) - the same "server judges, page draws"
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

  const hasLog = hasDayLog(log)
  const hasFigures = day.steps.value !== null || day.activeMinutes.value !== null
  if (!hasLog && !hasFigures && day.workouts.length === 0) return null

  const subtitle = t('sleep.night.day.subtitle', { date: formatLongDate(day.localDate, language) })

  return (
    <Card span={12} label={t('sleep.night.day.label')} basis={subtitle}>
      <DayLogBlock log={log} />
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
              <DayWorkoutList workouts={day.workouts} />
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
