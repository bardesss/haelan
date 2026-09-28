import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { SleepSchedule } from '../../../charts/SleepSchedule.js'
import { BalanceBars } from '../../../charts/BalanceBars.js'
import { formatDuration, formatSignedDuration } from '../../../format.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureValue, verdictLine } from './figureText.js'

/**
 * The week around this night: its schedule beside its balance, the mockup's "Slaapschema" and
 * "Slaapbalans" row. Two span-6 cards, which the existing mid-band rule halves to a full row each
 * and the phone rule (app.css's `.grid > *`) takes to span 12 either way, the same collapse every
 * other pair of half-width cards on this page relies on.
 *
 * Schedule and balance are drawn from two different arrays on the payload - the bedtime/waketime
 * figures' own seven-day strips, and `balance.nights` - so the two cards can carry a different
 * seven dates from each other (a night added to one and not the other, at the edges of what the
 * server can derive) without either card pretending to speak for the other's week.
 */
export function NightWeek({ page }: { page: NightPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { figures, balance } = page
  const bedtimeStrip = figures.bedtime.strip
  const waketimeStrip = figures.waketime.strip

  // Built from the strips rather than from `night` (the fixed night this page is otherwise about):
  // SleepSchedule draws one row per day the strip covers, the six nights before this one and this
  // one last, not the single night NightThrough already draws in full. Naps are always empty here:
  // this chart is the week's shape, not a second place naps are drawn (NightThrough already has
  // them), and showNaps={false} below is what tells the chart it was never asked to check.
  const scheduleNights = useMemo(() => {
    if (bedtimeStrip === null && waketimeStrip === null) return null
    const dates = (bedtimeStrip ?? waketimeStrip)!.map((day) => day.localDate)
    return dates.map((date, i) => ({
      date, bed: bedtimeStrip?.[i]?.value ?? null, wake: waketimeStrip?.[i]?.value ?? null, naps: [] as number[],
    }))
  }, [bedtimeStrip, waketimeStrip])

  const balanceValues = useMemo(() => balance.nights.map((n) => n.difference), [balance.nights])
  const balanceLabels = useMemo(() => balance.nights.map((n) => n.localDate), [balance.nights])

  const variabilityValue = formatFigureValue(
    figures.bedtimeVariability, figures.bedtimeVariability.value, language, t)
  const variabilityVerdict = verdictLine(figures.bedtimeVariability, language, t)

  const zeroLineValue = formatDuration(balance.zeroLine.minutes)
  const against = balance.zeroLine.source === 'target'
    ? t('sleep.night.week.balanceAgainstTarget', { target: zeroLineValue })
    : t('sleep.night.week.balanceAgainstBaseline', { usual: zeroLineValue })

  const scheduleLabel = t('sleep.night.week.schedule')
  const balanceLabel = t('sleep.night.week.balance')

  return (
    <>
      {scheduleNights !== null && (
        <Card span={6} label={scheduleLabel}>
          <SleepSchedule nights={scheduleNights} showNaps={false} label={scheduleLabel} />
          <p className="night-week-variability">
            {t('sleep.night.week.variability', { value: variabilityValue })}
          </p>
          {variabilityVerdict !== null && (
            <p className="night-hero-verdict">{variabilityVerdict}</p>
          )}
        </Card>
      )}
      <Card span={6} label={balanceLabel}>
        <div className="dash-headline night-week-total">{formatSignedDuration(balance.total, t('common.absent'))}</div>
        <p className="night-week-against">{against}</p>
        <BalanceBars values={balanceValues} labels={balanceLabels} label={balanceLabel}
          unit={t('sleep.balance.columnUnit')} />
      </Card>
    </>
  )
}
