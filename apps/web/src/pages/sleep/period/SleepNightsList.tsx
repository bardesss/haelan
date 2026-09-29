import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodRange, SleepListRow } from '../../../data/periodTypes.js'
import { ExpandableList } from '../../period/ExpandableList.js'
import { NightRow } from '../NightRow.js'
import { drawsNights } from './SleepScheduleCard.js'

const keyOf = (night: SleepListRow) => night.localDate
const monthOf = (night: SleepListRow) => night.localDate.slice(0, 7)

/**
 * "Nachten": the period's nights, newest first as the server sends them, under a caption saying so
 * and what the dot is, the seven most recent and the rest behind "Show all 30 nights"
 * (ExpandableList). The night that is the period's high (`longest`, the server's) says so. On 3 months and Year the expanded list is grouped by
 * month. The page owns `expanded`, since the card's width follows it.
 */
export function SleepNightsList({ nights, range, longest, span, expanded, onToggle }: {
  nights: SleepListRow[]
  range: PeriodRange
  /** The date of the period's high (its `high`), or null. */
  longest: string | null
  span: number
  expanded: boolean
  onToggle: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const monthLabel = useCallback((month: string) => new Date(`${month}-01T00:00:00Z`)
    .toLocaleString(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }), [language])
  const grouped = !drawsNights(range)
  const render = useCallback((night: SleepListRow): ReactNode => <NightRow night={night} longest={night.localDate === longest} />, [longest])
  const showAll = useCallback((count: number) => t('sleep.nights.showAll', { count }), [t])

  return (
    <Card span={span} label={t('sleep.nights.label')}>
      <p className="dash-caption night-list-caption">{t('sleep.nights.caption')}</p>
      <ExpandableList items={nights} keyOf={keyOf} render={render} expanded={expanded} onToggle={onToggle} showAll={showAll}
        groupOf={grouped ? monthOf : undefined} groupLabel={grouped ? monthLabel : undefined} />
    </Card>
  )
}
