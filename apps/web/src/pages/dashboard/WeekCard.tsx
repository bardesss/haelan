import { useTranslation } from '../../i18n/index.js'
import { formatNumber, formatDuration } from '../../format.js'
import type { Glance } from '../../data/useGlance.js'
import { DashCard } from './cardShared.js'
import { WeekBars } from './WeekBars.js'
import { hasWeek } from './dashboardRows.js'

/**
 * The week beside today: steps and active time as the seven-day total with the per-day average of
 * the finished days after it ("57,432 · 8,205 a day"), time asleep as the per-night average alone,
 * each with its own seven-day strip of bars - the approved T2 mockup's rows. A row that has no
 * figure (a metric never logged, or a night never recorded) is left out rather than drawn empty -
 * `hasWeek` already decided whether the card exists at all, so a single null row here is
 * unremarkable rather than a reason to hide the whole card.
 *
 * The total counts every strip day with a value, today so far included (the server's
 * GlanceWeekFigure.total); the average counts the finished days only. Two different spans on one
 * line, which is why the bars' accessible label says which the average is.
 *
 * No link: unlike Today, Recovery and Night, the week has no page of its own for this card to point
 * to, so `DashCard`'s optional `link` is left out.
 */
export function WeekCard({ glance, span }: { glance: Glance, span: 4 | 8 | 12 }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  if (!hasWeek(glance)) return null
  const rows: {
    key: 'steps' | 'active' | 'asleep', tone: 'steps' | 'active' | 'sleep',
    values: (number | null)[], value: string, per: string, withTotal: boolean,
    labelKey: 'glance.week.barsLabel' | 'glance.week.barsLabelNights',
  }[] = []
  const count = (value: number) => formatNumber(Math.round(value), 0, language, '')
  if (glance.week.steps !== null) {
    rows.push({
      key: 'steps', tone: 'steps', withTotal: true,
      values: glance.day.steps.strip.map((d) => d.value),
      value: count(glance.week.steps.total),
      per: t('glance.week.perDay', { value: count(glance.week.steps.perDay) }),
      labelKey: 'glance.week.barsLabel',
    })
  }
  if (glance.week.activeMinutes !== null) {
    rows.push({
      key: 'active', tone: 'active', withTotal: true,
      values: glance.day.activeMinutes.strip.map((d) => d.value),
      value: formatDuration(glance.week.activeMinutes.total),
      per: t('glance.week.perDay', { value: `${Math.round(glance.week.activeMinutes.perDay)} ${t('activity.units.min')}` }),
      labelKey: 'glance.week.barsLabel',
    })
  }
  if (glance.week.asleep !== null && glance.sleep !== null) {
    rows.push({
      key: 'asleep', tone: 'sleep', withTotal: false,
      values: glance.sleep.asleep.strip.map((d) => d.value),
      value: formatDuration(glance.week.asleep.perDay),
      // Unlike steps and active minutes (the server's weekOf drops today, which WeekBars still
      // highlights as the strip's last bar), the sleep strip ends on last night and weekOfFinished
      // already counts it - so this row's aria-label says the opposite of the other two rows'.
      per: t('glance.week.perNight'), labelKey: 'glance.week.barsLabelNights',
    })
  }
  return (
    <DashCard span={span} title={t('glance.week.title')} subtitle={t('glance.week.subtitle')}>
      {rows.map((row) => (
        <div className="dash-week-row" key={row.key}>
          <div>
            <span className="label">{t(`glance.week.${row.key}`)}</span>
            <div className="dash-week-figure">
              <span className="dash-week-value">{row.value}</span>{' '}
              <span className="dash-week-per">{row.withTotal ? t('glance.week.totalPer', { per: row.per }) : row.per}</span>
            </div>
          </div>
          <WeekBars values={row.values} tone={row.tone} label={t(row.labelKey, { what: t(`glance.week.${row.key}`) })} />
        </div>
      ))}
    </DashCard>
  )
}
