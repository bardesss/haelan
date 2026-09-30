import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { NightMonth, PeriodRange, SleepListRow } from '../../../data/periodTypes.js'
import { formatDuration } from '../../../format.js'
import { monthName } from '../../detail/periodText.js'
import { ExpandableList } from '../../period/ExpandableList.js'
import { NightRow } from '../NightRow.js'
import { drawsNights } from './SleepScheduleCard.js'

// A value never wraps inside itself (PATTERNS.md's Values).
const NBSP = '\u00a0'
const keyOf = (night: SleepListRow) => night.localDate
const monthOf = (night: SleepListRow) => night.localDate.slice(0, 7)

/**
 * "Nachten": the period's nights, newest first as the server sends them, under a caption saying so
 * and what the dot is, the seven most recent and the rest behind "Show all 30 nights"
 * (ExpandableList). The night that is the period's high (`longest`, the server's) says so. On 3
 * months and Year the list is grouped by month, collapsed as well as expanded, each month's header
 * naming its nights and their average time asleep from the server's `months` ("augustus · 31
 * nachten · gem. 7u 04m"). The page owns `expanded`, since the card's width follows it.
 */
export function SleepNightsList({ nights, months, range, longest, span, expanded, onToggle }: {
  nights: SleepListRow[]
  /** The server's summary of each month's nights. */
  months: NightMonth[]
  range: PeriodRange
  /** The date of the period's high (its `high`), or null. */
  longest: string | null
  span: number
  expanded: boolean
  onToggle: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // The month alone: a 3 months or a year never holds the same month twice, and the header names the year.
  const monthLabel = useCallback((month: string) => monthName(month, language), [language])
  const monthAside = useCallback((month: string) => {
    const summary = months.find((m) => m.month === month)
    if (summary === undefined) return null
    return summary.asleepMinutes === null
      ? t('sleep.nights.monthNights', { count: summary.nights })
      : t('sleep.nights.monthSummary', { count: summary.nights, average: formatDuration(summary.asleepMinutes, language).replace(' ', NBSP) })
  }, [months, language, t])
  const grouped = !drawsNights(range)
  const render = useCallback((night: SleepListRow): ReactNode => <NightRow night={night} longest={night.localDate === longest} />, [longest])
  const showAll = useCallback((count: number) => t('sleep.nights.showAll', { count }), [t])

  return (
    <Card span={span} label={t('sleep.nights.label')}>
      <p className="dash-caption night-list-caption">{t('sleep.nights.caption')}</p>
      <ExpandableList items={nights} keyOf={keyOf} render={render} expanded={expanded} onToggle={onToggle} showAll={showAll}
        groupOf={grouped ? monthOf : undefined} groupLabel={grouped ? monthLabel : undefined}
        groupAside={grouped ? monthAside : undefined} groupCollapsed={grouped} />
    </Card>
  )
}
