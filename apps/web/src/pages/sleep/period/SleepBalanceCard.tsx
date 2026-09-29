import { useId } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { BalanceBars } from '../../../charts/BalanceBars.js'
import { formatDuration, formatSignedDuration } from '../../../format.js'
import type { SleepPeriodData } from '../../../data/periodTypes.js'

/** Whether the period has a balance to draw: at least one night with a reading. */
export function hasBalance(balance: SleepPeriodData['balance']): boolean {
  return balance !== null && balance.values.some((value) => value !== null)
}

/**
 * "Slaapbalans": each night against the zero line the server chose (`zeroLine`: the person's usual
 * once it is worth standing on, their target until then, or the target always when they switched
 * the usual off), the period's running total over it, and which of the two it is, in the night
 * page's words. A night with no reading draws no bar rather than a zero (BalanceBars), and an
 * excluded night is named on the chart. A bar opens the day-metric exclude and annotate.
 */
export function SleepBalanceCard({ balance, dates, span, excluded, annotations, onPointClick }: {
  balance: NonNullable<SleepPeriodData['balance']>
  /** The hero's days, which the balance values run along one for one. */
  dates: string[]
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
    ? t('sleep.night.week.balanceAgainstTarget', { target: zeroLine })
    : t('sleep.night.week.balanceAgainstBaseline', { usual: zeroLine })
  // Signed both ways, as the night page signs it: a bare "0h 26m" reads as a size, not a surplus.
  const signed = formatSignedDuration(balance.total, t('common.absent'), language)
  const total = Math.round(balance.total) > 0 ? `+${signed}` : signed
  const label = t('sleep.night.week.balance')

  return (
    <Card span={span} label={label}>
      <div id={totalId}>
        <div className="dash-headline night-week-total">{total}</div>
        {' '}
        <p className="night-week-against">{against}</p>
      </div>
      <BasisContext.Provider value={totalId}>
        <BalanceBars values={balance.values} labels={dates} label={label} unit={t('sleep.balance.columnUnit')}
          excluded={excluded} annotations={annotations} onPointClick={onPointClick} />
      </BasisContext.Provider>
      <p className="dash-caption night-week-bars-caption">
        {t(target ? 'sleep.night.week.barsTarget' : 'sleep.night.week.barsBaseline')}
      </p>
    </Card>
  )
}
