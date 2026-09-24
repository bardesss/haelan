import { useTranslation } from '../../i18n/index.js'
import { formatNumber, formatDuration } from '../../format.js'
import type { Glance, GlanceFigure, GlanceWeekFigure } from '../../data/useGlance.js'
import { DashCard } from './cardShared.js'
import { WeekBars } from './WeekBars.js'
import { hasWeek } from './dashboardRows.js'

/**
 * The week beside today: steps, active minutes and time asleep averaged over the finished days of
 * the last seven, each with its own seven-day strip of bars. A row that has no figure (a metric
 * never logged, or a night never recorded) is left out rather than drawn empty - `hasWeek` already
 * decided whether the card exists at all, so a single null row here is unremarkable rather than a
 * reason to hide the whole card.
 *
 * No link: unlike Today, Recovery and Night, the week has no page of its own for this card to point
 * to, so `DashCard`'s optional `link` is left out.
 */
export function WeekCard({ glance, span }: { glance: Glance, span: 4 | 8 | 12 }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  if (!hasWeek(glance)) return null
  const rows: {
    key: 'steps' | 'active' | 'asleep', figure: GlanceWeekFigure, tone: 'steps' | 'active' | 'sleep',
    values: (number | null)[], value: string, basis: string, labelKey: 'glance.week.barsLabel' | 'glance.week.barsLabelNights',
  }[] = []
  const staleFigures: GlanceFigure[] = []
  if (glance.week.steps !== null) {
    rows.push({
      key: 'steps', figure: glance.week.steps, tone: 'steps',
      values: glance.day.steps.strip.map((d) => d.value),
      value: formatNumber(Math.round(glance.week.steps.perDay), 0, language, ''),
      basis: t('glance.week.perDay'), labelKey: 'glance.week.barsLabel',
    })
    staleFigures.push(glance.day.steps)
  }
  if (glance.week.activeMinutes !== null) {
    rows.push({
      key: 'active', figure: glance.week.activeMinutes, tone: 'active',
      values: glance.day.activeMinutes.strip.map((d) => d.value),
      value: `${Math.round(glance.week.activeMinutes.perDay)} ${t('activity.units.min')}`,
      basis: t('glance.week.perDay'), labelKey: 'glance.week.barsLabel',
    })
    staleFigures.push(glance.day.activeMinutes)
  }
  if (glance.week.asleep !== null && glance.sleep !== null) {
    rows.push({
      key: 'asleep', figure: glance.week.asleep, tone: 'sleep',
      values: glance.sleep.asleep.strip.map((d) => d.value),
      value: formatDuration(glance.week.asleep.perDay),
      // Unlike steps and active minutes (the server's weekOf drops today, which WeekBars still
      // highlights as the strip's last bar), the sleep strip ends on last night and weekOfFinished
      // already counts it - so this row's aria-label says the opposite of the other two rows'.
      basis: t('glance.week.perNight'), labelKey: 'glance.week.barsLabelNights',
    })
    staleFigures.push(glance.sleep.asleep)
  }
  return (
    <DashCard span={span} title={t('glance.week.title')} subtitle={t('glance.week.subtitle')} staleFigures={staleFigures}>
      {rows.map((row) => (
        <div className="dash-week-row" key={row.key}>
          <div>
            <span className="label">{t(`glance.week.${row.key}`)}</span>
            <div className="dash-week-value">{row.value}</div>
            <p className="dash-caption">{row.basis}</p>
          </div>
          <WeekBars values={row.values} tone={row.tone} label={t(row.labelKey, { what: t(`glance.week.${row.key}`) })} />
        </div>
      ))}
    </DashCard>
  )
}
