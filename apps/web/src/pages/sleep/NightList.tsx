import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { useNights } from '../../data/useNights.js'
import { oneNightPerDate } from '../../data/nights.js'
import { NightRow } from './NightRow.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { EmptyState } from '../../components/EmptyState.js'
import type { PageControlsState } from '../../controls/usePageControls.js'

/**
 * The list M8c adds below Sleep's cards, mirroring Activity's own session list: a count, rows under
 * a date heading, and its three query states handled by hand for the same reason SessionList does
 * it - a night carries no metric and no points, so there is no MetricCard to gate on.
 *
 * One row per date, not per (localDate, sourceId) row the route answers: two devices reporting one
 * night is, to a reader, one night, and oneNightPerDate states the rule (the longer recording wins).
 * Newest first, which is the opposite of the route's own ascending order.
 */
export function NightList({ controls }: { controls: PageControlsState }) {
  const { t, i18n } = useTranslation()
  const query = useNights({ from: controls.from, to: controls.to, source: controls.source })

  // No spread before reverse(): oneNightPerDate already returns a fresh array
  // ([...byDate.values()].sort(...), data/nights.ts), so there is no shared reference here for an
  // in-place reverse() to corrupt.
  const nights = useMemo(
    () => oneNightPerDate(query.data?.items ?? []).reverse(),
    [query.data],
  )

  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} error={query.error} />
  if (query.isPending) return <Loading />
  if (nights.length === 0) {
    return <EmptyState title={t('sleep.nights.emptyTitle')} detail={t('sleep.nights.emptyDetail')} />
  }

  return (
    <div className="night-list">
      <div className="night-list-header">
        <span className="night-list-count">{t('sleep.nights.count', { count: nights.length })}</span>
      </div>
      <p className="basis">{t('sleep.nights.basis')}</p>
      {/* A flat list, not dates grouping rows. SessionList's shape - a heading, then the rows
          under it - earns its keep on Activity, where one day really can hold three sessions.
          Here it cannot: this component's own rule, stated above, is one row per date, so every
          group held exactly one row and each night cost a heading, a group gap and a row to say
          one thing. The date is a column of the row instead. */}
      <div className="night-groups">
        {nights.map((night) => <NightRow key={night.localDate} night={night} />)}
      </div>
    </div>
  )
}
