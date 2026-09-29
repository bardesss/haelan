import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodRange, SleepListRow } from '../../../data/periodTypes.js'
import { ExpandableList } from '../../period/ExpandableList.js'
import { NightRow } from '../NightRow.js'
import { drawsNights } from './SleepScheduleCard.js'

const keyOf = (night: SleepListRow) => night.localDate
const render = (night: SleepListRow) => <NightRow night={night} />
const monthOf = (night: SleepListRow) => night.localDate.slice(0, 7)

/**
 * "Nachten": the period's nights, newest first as the server sends them, the seven most recent and
 * the rest behind "Show all" (ExpandableList). On 3 months and Year the expanded list is grouped by
 * month. The page owns `expanded`, since the card's width follows it.
 */
export function SleepNightsList({ nights, range, span, expanded, onToggle }: {
  nights: SleepListRow[]
  range: PeriodRange
  span: number
  expanded: boolean
  onToggle: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const monthLabel = useCallback((month: string) => new Date(`${month}-01T00:00:00Z`)
    .toLocaleString(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }), [language])
  const grouped = !drawsNights(range)

  return (
    <Card span={span} label={t('sleep.nights.label')}>
      <ExpandableList items={nights} keyOf={keyOf} render={render} expanded={expanded} onToggle={onToggle}
        groupOf={grouped ? monthOf : undefined} groupLabel={grouped ? monthLabel : undefined} />
    </Card>
  )
}
