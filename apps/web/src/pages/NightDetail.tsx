import { useMemo } from 'react'
import { useTranslation } from '../i18n/index.js'
import { useRoute, routeParams, readQuery } from '../router.js'
import { NIGHT_ROUTE } from '../routes.js'
import { useNights } from '../data/useNights.js'
import { nightFor } from '../data/nights.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { NightHeader } from './sleep/NightHeader.js'
import { Card } from '../components/Card.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { EmptyState } from '../components/EmptyState.js'

/**
 * One night, everything recorded about it.
 *
 * Keyed by local date rather than by id, unlike the workout page: a Night has no id at all - it is
 * assembled per (localDate, sourceId) across several sessions - and that asymmetry is a fact about
 * the data rather than an inconsistency to paper over.
 *
 * The reader's source comes from the URL, resolved against the sources this person actually has,
 * the same rule every other page applies: a link can name a source this person does not have, and a
 * source can be removed after a link was made, and both should read as the all-sources view.
 */
export function NightDetail() {
  const { t } = useTranslation()
  const route = useRoute()
  const localDate = routeParams(NIGHT_ROUTE, route)?.localDate
  const { sources } = useSourceNames()
  const named = readQuery(route.split('?')[1] ?? '').get('source') ?? ALL_SOURCES
  const source = resolveSource(named, [ALL_SOURCES, ...sources.map((s) => s.id)])

  // The all-sources request when `localDate` is not yet known, so useNights builds a real range
  // object either way (its cache key is fine sharing a key across renders before it ever fires);
  // `enabled` is the only thing that stops it from firing as `?from=&to=`.
  const range = { from: localDate ?? '', to: localDate ?? '', source }
  const query = useNights(range, { enabled: localDate !== undefined })
  const night = useMemo(
    () => nightFor(query.data?.items ?? [], source),
    [query.data, source],
  )

  if (query.isError) {
    return <div className="grid"><Card span={12}><ErrorState onRetry={() => void query.refetch()} /></Card></div>
  }
  if (query.isPending) return <div className="grid"><Card span={12}><Loading /></Card></div>
  if (night === null) {
    return (
      <div className="grid">
        <Card span={12}>
          <EmptyState title={t('sleep.night.missingTitle')} detail={t('sleep.night.missingDetail')} />
        </Card>
      </div>
    )
  }

  return (
    <>
      <NightHeader night={night} />
      <div className="grid" />
    </>
  )
}
