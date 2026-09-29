import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { SleepSchedule } from '../../../charts/SleepSchedule.js'
import { BalanceBars } from '../../../charts/BalanceBars.js'
import { inWindow, withinSchedule, WIDE_WINDOW } from '../../../charts/schedule.js'
import { formatDuration, formatSignedDuration } from '../../../format.js'
import type { GlanceBaseline } from '../../../data/useGlance.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureRange, formatFigureValue } from '../../detail/figureText.js'
import { verdictTone } from '../../../components/FigureRow.js'

/**
 * A usual bed or wake range placed in the schedule's frame: shifted by the whole day `anchorRaw`
 * would be shifted by (inWindow's rule), then kept its own width, so a range straddling midnight
 * stays one span. Null for a thin or absent usual, which draws no band (FigureRow's rule for a bar).
 *
 * The wake range is anchored on the usual bedtime rather than on itself: a wake time is placed as
 * its night's bed plus the night's length (withinSchedule), so it moves by whatever day its bedtime
 * moved by, and a wake range shifted on its own terms would land a day away from the bars it
 * describes. 1440 stands in with no usual bedtime to anchor on, the shift every night that ended
 * this morning takes anyway (napInWindow's same fallback).
 */
function placedBand(baseline: GlanceBaseline | null, anchorRaw: number | null): { low: number, high: number } | null {
  if (baseline === null || baseline.thin) return null
  const shift = anchorRaw === null ? 1440 : inWindow(anchorRaw, WIDE_WINDOW) - anchorRaw
  return { low: baseline.low + shift, high: baseline.high + shift }
}

/**
 * The week around this night: its schedule beside its balance, the mockup's "Slaapschema" and
 * "Slaapbalans" row. Two span-6 cards, which the existing mid-band rule halves to a full row each
 * and the phone rule (app.css's `.grid > *`) takes to span 12 either way, the same collapse every
 * other pair of half-width cards on this page relies on. When one of the two has nothing to draw
 * and hides, the other takes the whole row rather than leaving half of it empty.
 *
 * Schedule and balance are drawn from two different arrays on the payload - the bedtime/waketime
 * figures' own seven-day strips, and `balance.nights` - so the two cards can carry a different
 * seven dates from each other (a night added to one and not the other, at the edges of what the
 * server can derive) without either card pretending to speak for the other's week.
 */
export function NightWeek({ page }: { page: NightPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const variabilityId = useId()
  const balanceId = useId()
  const { figures, balance } = page
  const bedtimeStrip = figures.bedtime.strip
  const waketimeStrip = figures.waketime.strip

  // Built from the strips rather than from `night` (the fixed night this page is otherwise about):
  // SleepSchedule draws one row per day the strip covers, the six nights before this one and this
  // one last, not the single night NightThrough already draws in full. Each pair is placed in the
  // wide window's frame first (withinSchedule, the Sleep page's own rule): the strips carry minutes
  // from the wake date's midnight, a 23:40 bedtime as -20, and handed to the chart raw a bedtime
  // before midnight sat below a wake time after it on no axis at all, which drew no bars. Naps are
  // always empty here: this chart is the week's shape, not a place naps are drawn, and
  // showNaps={false} below is what tells the chart it was never asked to check.
  const scheduleNights = useMemo(() => {
    if (bedtimeStrip === null && waketimeStrip === null) return null
    const dates = (bedtimeStrip ?? waketimeStrip)!.map((day) => day.localDate)
    return dates.map((date, i) => ({
      date,
      ...withinSchedule(bedtimeStrip?.[i]?.value ?? null, waketimeStrip?.[i]?.value ?? null, WIDE_WINDOW),
      naps: [] as number[],
    }))
  }, [bedtimeStrip, waketimeStrip])

  const bedBaseline = figures.bedtime.baseline
  const wakeBaseline = figures.waketime.baseline
  const usualBands = useMemo(() => {
    const bed = placedBand(bedBaseline, bedBaseline?.low ?? null)
    const wake = placedBand(wakeBaseline, bedBaseline?.center ?? null)
    return [bed, wake].filter((band): band is { low: number, high: number } => band !== null)
  }, [bedBaseline, wakeBaseline])

  const balanceValues = useMemo(() => balance.nights.map((n) => n.difference), [balance.nights])
  const balanceLabels = useMemo(() => balance.nights.map((n) => n.localDate), [balance.nights])
  const hasBalance = balanceValues.some((value) => value !== null)

  // One line for the week's variability and its usual, the mockup's "Bedtime varied ±28 min this
  // week · usually ±20–35 min": the usual half only when there is a real one to name.
  const variability = figures.bedtimeVariability
  const variabilityTone = verdictTone(variability.judged, variability.standing)
  const variabilityValue = formatFigureValue(variability, variability.value, language, t)
  const variabilityBand = variability.baseline !== null && !variability.baseline.thin ? variability.baseline : null
  // The usual in the one range format every page prints (formatFigureRange): spaced dash, the unit
  // once after the high.
  const variabilityRange = variabilityBand === null ? null
    : formatFigureRange(variability, variabilityBand.low, variabilityBand.high, language, t)
  const variabilityLine = variabilityRange === null
    ? t('sleep.night.week.variability', { value: variabilityValue })
    : t('sleep.night.week.variabilityUsual', { value: variabilityValue, low: variabilityRange.low, high: variabilityRange.high })

  const zeroLineValue = formatDuration(balance.zeroLine.minutes)
  const target = balance.zeroLine.source === 'target'
  const against = target
    ? t('sleep.night.week.balanceAgainstTarget', { target: zeroLineValue })
    : t('sleep.night.week.balanceAgainstBaseline', { usual: zeroLineValue })
  // Signed both ways: formatSignedDuration marks a deficit and leaves a surplus bare, and a bare
  // "0h 26m" on a balance reads as a size rather than as a week ahead.
  const signedTotal = formatSignedDuration(balance.total, t('common.absent'))
  const total = Math.round(balance.total) > 0 ? `+${signedTotal}` : signedTotal

  const scheduleLabel = t('sleep.night.week.schedule')
  const balanceLabel = t('sleep.night.week.balance')
  const span = scheduleNights !== null && hasBalance ? 6 : 12

  return (
    <>
      {scheduleNights !== null && (
        <Card span={span} label={scheduleLabel}>
          <BasisContext.Provider value={variabilityId}>
            <SleepSchedule nights={scheduleNights} showNaps={false} label={scheduleLabel} usualBands={usualBands} />
          </BasisContext.Provider>
          <p id={variabilityId}
            className={variabilityTone === null ? 'detail-verdict' : `detail-verdict ${variabilityTone}`}>
            {variabilityLine}
          </p>
        </Card>
      )}
      {hasBalance && (
        <Card span={span} label={balanceLabel}>
          <div id={balanceId}>
            <div className="dash-headline night-week-total">{total}</div>
            {' '}
            <p className="night-week-against">{against}</p>
          </div>
          <BasisContext.Provider value={balanceId}>
            <BalanceBars values={balanceValues} labels={balanceLabels} label={balanceLabel}
              unit={t('sleep.balance.columnUnit')} />
          </BasisContext.Provider>
          <p className="dash-caption night-week-bars-caption">
            {t(target ? 'sleep.night.week.barsTarget' : 'sleep.night.week.barsBaseline')}
          </p>
        </Card>
      )}
    </>
  )
}
