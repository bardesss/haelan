import { useTranslation } from '../i18n/index.js'

/**
 * What a `MetricCard` renders in place of its chart on a one day range, instead of the chart
 * itself.
 *
 * Deliberately not `EmptyState`: `EmptyState` is a title plus a detail line standing in for a
 * card's *entire* content (no_data and not_worn both mean "nothing below the label is worth
 * drawing"), and a one day range with a value is not that case. The value, its delta and the
 * basis line all still render around this; only the chart a trend line would otherwise draw one
 * dot for is replaced, with one short line saying why, not a title-and-detail pair explaining a
 * card that is not actually empty.
 *
 * A shared component rather than six inline copies of the same `<p>` and translation call, since
 * six is exactly the number of call sites this task's own `MetricCard` callers reach (Dashboard's
 * four tiles and its sleep schedule card, and each of Recovery's, Sleep's, Weight's and Activity's
 * own single shared card()).
 */
export function ChartNote() {
  const { t } = useTranslation()
  return <p className="chart-note">{t('charts.singleDayNote')}</p>
}
