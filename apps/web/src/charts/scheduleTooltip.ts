import { formatClock } from '../format.js'
import type { Translate } from '../format.js'
import type { Night } from './schedule.js'

/**
 * One hovered night, or one hovered nap, said the way the accessible table's own row says it.
 *
 * **The night is resolved through the point's own value, never through `dataIndex`**, and that is
 * the whole reason this is a function rather than three lines inline. This chart draws two series
 * over one `nights` array: the custom series is one entry per night, so there its `dataIndex`
 * would work, but the naps scatter is built with `nights.flatMap((n, i) => n.naps.map(...))`, so
 * ITS `dataIndex` counts into a flattened list of every nap across every night. The first nap in
 * that list can belong to any night, and indexing `nights` by it names whichever night happens to
 * sit at that small number - the same class of defect HeartRateRange's own markPoint/markLine
 * branch exists for. Both series encode the night index as the first element of the point's value,
 * because that is what positions them on the x axis, so reading it is both correct and the only
 * thing the two series agree on.
 */
export function scheduleTooltip(
  nights: readonly Night[],
  event: { seriesType?: string; value?: unknown },
  t: Translate,
): string {
  const value = Array.isArray(event.value) ? event.value : undefined
  const index = typeof value?.[0] === 'number' ? value[0] : undefined
  const night = index === undefined ? undefined : nights[index]
  if (!night) return ''

  if (event.seriesType === 'scatter') {
    const at = typeof value?.[1] === 'number' ? value[1] : undefined
    if (at === undefined) return ''
    return `${night.date}<br/>${t('charts.tooltip.line', {
      label: t('charts.columns.naps'), value: formatClock(at),
    })}`
  }

  // The same word, and the same reason, as the table's own bed/wake cells: a missing end is an
  // absence, not a zero, and a zero on this axis would read as a real clock time.
  const absent = t('charts.absence.noReading')
  return [
    night.date,
    t('charts.tooltip.line', {
      label: t('charts.columns.toBed'), value: night.bed === null ? absent : formatClock(night.bed),
    }),
    t('charts.tooltip.line', {
      label: t('charts.columns.woke'), value: night.wake === null ? absent : formatClock(night.wake),
    }),
  ].join('<br/>')
}
