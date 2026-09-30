import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { BalanceBars } from '../../../charts/BalanceBars.js'
import { periodAxisLabels } from '../../../charts/barAxis.js'
import { formatDuration, formatSignedDuration } from '../../../format.js'
import type { PeriodRange, SleepPeriodData } from '../../../data/periodTypes.js'

const NONE: never[] = []

/** Whether the period has a balance to draw: at least one night with a reading. */
export function hasBalance(balance: SleepPeriodData['balance']): boolean {
  return balance !== null && balance.values.some((value) => value !== null)
}

/**
 * "Slaapbalans": each night against the zero line the server chose (`zeroLine`: the person's usual
 * once it is worth standing on, their target until then, or the target always when they switched
 * the usual off), the period's running total over it, which of the two it is and over how many
 * nights ("against your usual 7h 08m, over 30 nights"), the night count the server's (the hero's
 * `days`, the nights with a reading, which are the nights with a balance). A night with no reading
 * draws no bar rather than a zero (BalanceBars), and an excluded night is named on the chart. A bar
 * opens the day-metric exclude and annotate.
 *
 * On 3 months and Year a bar is a week, its nights added up (the server's `weekly`), as the year
 * mockup draws it: a year of single nights is no chart to read. A week is no one night to exclude or
 * annotate, so its bars open nothing and carry no night's marks.
 */
export function SleepBalanceCard({ balance, range, dates, nights, span, excluded, annotations, onPointClick }: {
  balance: NonNullable<SleepPeriodData['balance']>
  range: PeriodRange
  /** The hero's days, which the balance values run along one for one. */
  dates: string[]
  /** The nights with a reading, which the total adds up. */
  nights: number
  span: number
  excluded: string[]
  annotations: { date: string, text: string }[]
  onPointClick: (localDate: string) => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const totalId = useId()

  const zeroLine = formatDuration(balance.zeroLine.minutes, language)
  const target = balance.zeroLine.source === 'target'
  const against = target
    ? t('sleep.period.balanceAgainstTarget', { target: zeroLine, count: nights })
    : t('sleep.period.balanceAgainstBaseline', { usual: zeroLine, count: nights })
  // Signed both ways, as the night page signs it: a bare "0h 26m" reads as a size, not a surplus.
  const signed = formatSignedDuration(balance.total, t('common.absent'), language)
  const total = Math.round(balance.total) > 0 ? `+${signed}` : signed
  const label = t('sleep.night.week.balance')
  const weekly = range === '3months' || range === 'year'
  const values = useMemo(() => (weekly ? balance.weekly.map((week) => week.value) : balance.values), [weekly, balance])
  const labels = useMemo(() => (weekly ? balance.weekly.map((week) => week.from) : dates), [weekly, balance, dates])
  const axis = useMemo(() => periodAxisLabels(labels, range, language), [labels, range, language])
  const caption = weekly
    ? (target ? 'sleep.period.barsWeeklyTarget' : 'sleep.period.barsWeeklyBaseline')
    : (target ? 'sleep.night.week.barsTarget' : 'sleep.night.week.barsBaseline')

  return (
    <Card span={span} label={label}>
      <div id={totalId}>
        <div className="dash-headline night-week-total">{total}</div>
        {' '}
        <p className="night-week-against">{against}</p>
      </div>
      <BasisContext.Provider value={totalId}>
        <BalanceBars values={values} labels={labels} label={label} unit={t('sleep.balance.columnUnit')} axis={axis}
          excluded={weekly ? NONE : excluded} annotations={weekly ? NONE : annotations} onPointClick={weekly ? undefined : onPointClick} />
      </BasisContext.Provider>
      <p className="dash-caption night-week-bars-caption">
        {t(caption)}
      </p>
    </Card>
  )
}
