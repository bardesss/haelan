import { useTranslation } from '../i18n/index.js'
import { useRoute, routeParams, readQuery } from '../router.js'
import { NIGHT_ROUTE } from '../routes.js'
import { useNightPage } from '../data/useNightPage.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { NightTop, useOpenNight } from './sleep/night/NightTop.js'
import { NightHero } from './sleep/night/NightHero.js'
import { NightMinis } from './sleep/night/NightMinis.js'
import { NightThrough } from './sleep/night/NightThrough.js'
import { NightWeek } from './sleep/night/NightWeek.js'
import { NightMorning } from './sleep/night/NightMorning.js'
import { NightMore } from './sleep/night/NightMore.js'
import { NightDay } from './sleep/night/NightDay.js'
import { NightAbout } from './sleep/night/NightAbout.js'
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
  const openNight = useOpenNight()
  // null, not ALL_SOURCES: useSourceTrace's own chosenSource takes "the reader named no source" as
  // null specifically, and the all-sources sentinel is this page's spelling of that, not a source
  // name a trace could ever pin to.
  const chosenSource = source === ALL_SOURCES ? null : source

  if (query.isError) {
    // A date with no night answers 404 (routes/v1/detail.ts's no_such_night), as does a demo
    // manifest miss; both read as "no night recorded" rather than as a failure to retry. The header
    // stays, titled with the date asked for, so the way back and the list are one tap away.
    const notFound = query.error instanceof ApiError && query.error.kind === 'not_found'
    return (
      <div className="detail-page">
        <NightTop localDate={localDate} />
        <div className="grid">
          <Card span={12}>
            {notFound
              ? <EmptyState title={t('sleep.night.missingTitle')} detail={t('sleep.night.missingDetail')} />
              : <ErrorState onRetry={() => void query.refetch()} error={query.error} />}
          </Card>
        </div>
      </div>
    )
  }
  if (query.isPending) {
    return <div className="detail-page"><NightTop localDate={localDate} /><div className="grid"><Card span={12}><Loading /></Card></div></div>
  }

  const page = query.data
  // The "About this night" fold at the foot of the page is the pre-M10a session list (task 7
  // renamed and re-housed it, never rewrote it); it draws from this payload's `night`, so the page
  // still makes one read for the night either way.
  return (
    <div className="detail-page">
      <NightTop localDate={localDate} page={page} />
      <div className="grid">
        <NightHero asleep={page.figures.asleep} localDate={page.localDate} onOpenNight={openNight} />
        <NightMinis figures={page.figures} />
        <NightThrough page={page} chosenSource={chosenSource} />
        <NightWeek page={page} />
        <NightMorning page={page} />
        <NightMore figures={page.figures} />
        <NightDay day={page.day} log={page.log} />
        <NightAbout night={page.night} />
      </div>
    </div>
  )
}
