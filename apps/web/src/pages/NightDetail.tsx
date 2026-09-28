import { useTranslation } from '../i18n/index.js'
import { useRoute, routeParams, readQuery } from '../router.js'
import { NIGHT_ROUTE } from '../routes.js'
import { useNightPage } from '../data/useNightPage.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { NightTop } from './sleep/night/NightTop.js'
import { NightHero } from './sleep/night/NightHero.js'
import { NightMinis } from './sleep/night/NightMinis.js'
import { NightThrough } from './sleep/night/NightThrough.js'
import { NightSessions } from './sleep/NightSessions.js'
import { Card } from '../components/Card.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { EmptyState } from '../components/EmptyState.js'
import { ApiError } from '../api/client.js'

/**
 * One night, everything recorded about it (M10a): the header row, time asleep against its usual,
 * the four figures under it, then the sections below, all from one read (useNightPage) that the
 * server has already judged.
 *
 * Keyed by local date rather than by id, unlike the workout page: a Night has no id at all - it is
 * assembled per (localDate, sourceId) across several sessions - and that asymmetry is a fact about
 * the data rather than an inconsistency to paper over.
 *
 * The page's figures are the one night the server picks for the date. The reader's `source` from
 * the URL still reaches the night traces, resolved against the sources this person actually has,
 * the rule every other page applies: a link can name a source this person does not have, and a
 * source can be removed after a link was made, and both should read as the all-sources view.
 */
export function NightDetail() {
  const { t } = useTranslation()
  const route = useRoute()
  const localDate = routeParams(NIGHT_ROUTE, route)?.localDate
  const { sources } = useSourceNames()
  const named = readQuery(route.split('?')[1] ?? '').get('source') ?? ALL_SOURCES
  const source = resolveSource(named, [ALL_SOURCES, ...sources.map((s) => s.id)])
  const query = useNightPage(localDate)
  // null, not ALL_SOURCES: useSourceTrace's own chosenSource takes "the reader named no source" as
  // null specifically, and the all-sources sentinel is this page's spelling of that, not a source
  // name a trace could ever pin to.
  const chosenSource = source === ALL_SOURCES ? null : source

  if (query.isError) {
    // A date with no night answers 404 (routes/v1/detail.ts's no_such_night), as does a demo
    // manifest miss; both read as "no night recorded" rather than as a failure to retry.
    const notFound = query.error instanceof ApiError && query.error.kind === 'not_found'
    return (
      <div className="grid">
        <Card span={12}>
          {notFound
            ? <EmptyState title={t('sleep.night.missingTitle')} detail={t('sleep.night.missingDetail')} />
            : <ErrorState onRetry={() => void query.refetch()} error={query.error} />}
        </Card>
      </div>
    )
  }
  if (query.isPending) return <div className="grid"><Card span={12}><Loading /></Card></div>

  const page = query.data
  // The sessions card below the night is the pre-M10a one, still reading the night itself; it draws
  // it from this payload's `night`, so the page makes one read for the night either way.
  return (
    <div className="night-page">
      <NightTop page={page} />
      <div className="grid">
        <NightHero asleep={page.figures.asleep} />
        <NightMinis figures={page.figures} />
        <NightThrough page={page} chosenSource={chosenSource} />
        <NightSessions night={page.night} />
      </div>
    </div>
  )
}
