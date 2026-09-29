import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { FigureRow } from '../../../components/FigureRow.js'
import { formatLongDate } from '../../dashboard/glanceText.js'
import { TodayWorkouts } from '../../dashboard/TodayWorkouts.js'
import { DayLogBlock, SideCard, hasDayLog } from '../../detail/DayLogBlock.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureValue, verdictLine } from './figureText.js'

/**
 * The day before the night (M10a-2 task 7, the mockup's "Die dag"): how it felt, what was tapped
 * and written down through the quick log, and its steps, active minutes and workouts, all read
 * off `page.day` and `page.log` rather than computed here - the same "server judges, page draws"
 * split every figure on this page already keeps.
 *
 * Drawn in the detail pages' shared side layout (SideCard: which day on the left, the rows on the
 * right), with the log as DayLogBlock draws it and the workouts as the dashboard's own rows
 * (TodayWorkouts, SessionRow underneath), so a ride reads here exactly as it does there.
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

  const hasFigures = day.steps.value !== null || day.activeMinutes.value !== null
  if (!hasDayLog(log) && !hasFigures && day.workouts.length === 0) return null

  const caption = t('sleep.night.day.subtitle', { date: formatLongDate(day.localDate, language) })
  const figures = [
    { key: 'steps', label: t('sleep.night.day.steps'), figure: day.steps },
    { key: 'activeMinutes', label: t('sleep.night.day.activeMinutes'), figure: day.activeMinutes },
  ].filter(({ figure }) => figure.value !== null)

  return (
    <SideCard label={t('sleep.night.day.label')} caption={caption}>
      <DayLogBlock log={log} />
      {figures.length > 0 && (
        <div className="detail-side-rows">
          {figures.map(({ key, label, figure }) => (
            <FigureRow key={key} label={label} value={formatFigureValue(figure, figure.value, language, t)}
              verdict={verdictLine(figure, language, t) ?? t('glance.usual.none')}
              judged={figure.judged} standing={figure.standing} band={figure.baseline} mark={figure.value} />
          ))}
        </div>
      )}
      <TodayWorkouts workouts={day.workouts} label={t('sleep.night.day.workouts')} />
    </SideCard>
  )
}
