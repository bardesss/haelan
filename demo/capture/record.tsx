// The sweep: mounts every unparameterised page of the real app, under every range preset, one
// step back, every source option, and a handful of real detail pages, against a real seeded
// instance (through startCaptureServer's app.inject() bridge, no port and no network), and records
// what each one asked for. This is what makes the demo's coverage a fact about the running app
// rather than a hand-written list - see the spec's own note on why the coverage guarantee follows
// from the sweep instead of from a separate list test.
//
// Run only through demo/capture/vitest.config.ts (`pnpm demo:capture`, scripts/capture-demo.mjs's
// own job), never through `pnpm test`: this file sits outside every include glob that config
// covers, and vitest.config.ts's own comment explains why that separation has to hold.
//
// Talks to its orchestrator (scripts/capture-demo.mjs) two ways, since the two run as separate
// processes with nothing to share in memory: HAELAN_DEMO_DATA_DIR/HAELAN_DEMO_OUT_DIR/
// HAELAN_DEMO_DAYS/HAELAN_DEMO_REPORT_FILE arrive as environment variables (set when
// capture-demo.mjs spawns this file's own vitest run), and the finished report goes back out as a
// small JSON file at HAELAN_DEMO_REPORT_FILE rather than a marked console line - capture-demo.mjs's
// own comment on why explains the race a stdout line lost silently on Windows.
import { writeFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../apps/web/src/Shell.js'
import { navigate } from '../../apps/web/src/router.js'
import { ROUTES, WORKOUT_ROUTE, NIGHT_ROUTE } from '../../apps/web/src/routes.js'
import { RANGE_KEYS, addDays, datesFor, stepAnchor } from '../../apps/web/src/controls/range.js'
import { ALL_SOURCES } from '../../apps/web/src/controls/source.js'
import { sourcesIn } from '../../apps/web/src/data/pageShell.js'
import { CHART_VARS } from '../../apps/web/src/charts/tokens.js'
import { DEMO_CLOCK_MS } from '../../apps/web/src/demo/instant.js'
import { flush } from '../../apps/web/test/flush.js'
import { startCaptureServer } from './server.js'
import type { CaptureServer } from './server.js'
import { writeCapture } from '../../scripts/capture-demo.mjs'
import type { WorkoutSession } from '../../apps/web/src/data/useSessions.js'
import type { Night } from '../../apps/web/src/data/useNights.js'
import type { MetricSeries } from '../../apps/web/src/data/useSeries.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" the
// moment a chart-bearing card draws - every page test under apps/web/test that mounts a real page
// works around this the same way (dashboard-round-trip.test.tsx's own comment explains why).
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

// The root vitest.config.ts sets this from a setup file (its own comment: React checks it before
// deciding whether act() warnings apply). This config has no setup file of its own - one test file
// is the whole of what it runs - so the flag is set here instead, at the same point every other
// happy-dom suite in this repository sets it.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dataDir = process.env.HAELAN_DEMO_DATA_DIR
const outDir = process.env.HAELAN_DEMO_OUT_DIR
const reportFile = process.env.HAELAN_DEMO_REPORT_FILE
const seededDays = Number(process.env.HAELAN_DEMO_DAYS ?? '365')
if (dataDir === undefined || outDir === undefined || reportFile === undefined) {
  throw new Error(
    'record.tsx needs HAELAN_DEMO_DATA_DIR, HAELAN_DEMO_OUT_DIR and HAELAN_DEMO_REPORT_FILE - run '
    + 'it through `pnpm demo:capture` (scripts/capture-demo.mjs), not directly',
  )
}

// The Amsterdam calendar date the pinned clock (below) reads as "today" - DEMO_CLOCK_MS, not
// DEMO_INSTANT_MS: instant.ts's own comment explains why the archive's exclusive close is the
// wrong instant to read a calendar day off of. Derived rather than a second copy of a date string,
// for the same reason instant.ts derives DEMO_CLOCK_MS itself rather than being handed one.
const DEMO_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(DEMO_CLOCK_MS)

// The routes whose ControlRow offers a real source picker (Dashboard.tsx through Weight.tsx all
// build `sources` from distinctSources and pass it down). Notes has a ControlRow but no sources
// (its own comment: a note is not read off a device); Settings, Account and Nutrition have no
// ControlRow at all - routes.tsx's own table names every unparameterised path, and this is that
// table minus those four.
const SOURCE_ROUTES = new Set(['/', '/activity', '/sleep', '/recovery', '/health', '/weight'])

/** Whether `path` reads range/anchor from the url at all. Settings, Account and Nutrition are
 *  the routes in ROUTES that do not (mount()'s own guard comment on Settings, which Account was
 *  split out of and inherits, and Nutrition.tsx's own comment on why it has no data hook to read
 *  a range for in the first place). */
function usesPageControls(path: string): boolean {
  // /records (M6c) is the third, and the only one rangeless by design rather than by subject:
  // every figure on it is an all-time figure, so it has no ControlRow at all and its query key
  // carries no range. Five range mounts therefore ask for one already-cached resource, and only
  // the first is owed a landing.
  return path !== '/settings' && path !== '/account' && path !== '/nutrition' && path !== '/records'
}

let server: CaptureServer
let restoreFetch: () => void

beforeAll(async () => {
  server = await startCaptureServer(dataDir)
  const original = globalThis.fetch
  globalThis.fetch = server.fetch
  restoreFetch = () => { globalThis.fetch = original }
  // Pinned for real: usePageControls' default anchor and historicalTo both read `new Date()`
  // directly, and so does useSyncStatus' "how long ago" - none of them go through apiGet/apiSend,
  // so swapping fetch above does nothing for them. Left unpinned, every url keyed on "today"
  // (insights, baselines) would carry whatever day this happened to run rather than the seed's own
  // last day, missing on replay against Task 5's own frozen clock and drifting to a new set of keys
  // on every future capture run besides. `vi.setSystemTime` alone, without `vi.useFakeTimers()`
  // first, fakes only `Date` and leaves real timers running - flush()'s own setTimeout-based
  // polling needs those to keep firing.
  vi.setSystemTime(DEMO_CLOCK_MS)
}, 120_000)

afterAll(() => {
  vi.useRealTimers()
  restoreFetch()
  server.close()
})

/**
 * Whether `key` belongs to one of the three queries every page's own ControlRow reads
 * (useSession, useSyncStatus, useSourceNames - the third by the resource name its own query key
 * carries, `sources`, not to be confused with a page's locally computed `sources` prop). Moving
 * from one page to a different one remounts ControlRow (two different pages' control rows are two
 * different fiber positions, never the same component persisting across the switch), which
 * refetches these three regardless of whether the page underneath fetched anything of its own -
 * confirmed against the installed react-query, a bare remount grows the count by two. A guard
 * built on the raw total could not tell that apart from the page's own real fetch, which is
 * exactly the hole recording was chosen to close: a page that issues no requests of its own would
 * still show "growth" on the first mount after a route change.
 */
function isChromeQuery(key: readonly unknown[]): boolean {
  if (key[0] === 'session') return true
  return key[0] === 'person' && (key[2] === 'sync-status' || key[2] === 'sources')
}

/**
 * How many of `client`'s own, non-chrome queries have ever landed a real result. Counts
 * `dataUpdateCount` only, not `errorUpdateCount`: a query that only ever 400s or 404s contributed
 * nothing to `server.recorded` either (captureFetch's own refusals throw before it ever calls
 * `recorded.set`), so counting errors here would call a page that talks to the server and gets
 * nothing back the same "recorded something" that a page which actually got data is.
 */
function successfulLandings(client: QueryClient): number {
  return client.getQueryCache().getAll()
    .filter((query) => !isChromeQuery(query.queryKey as readonly unknown[]))
    .reduce((total, query) => total + query.state.dataUpdateCount, 0)
}

describe('the capture sweep', () => {
  it('mounts every page and records what each one asks for', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    /**
     * Pushes `path` into history, mounts the real App tree fresh, and waits for it to settle,
     * then asserts the mount actually landed at least one successful non-chrome query result.
     *
     * That guard is `successfulLandings` growing, not `server.recorded.size` growing: several
     * pages' own annotation overlays (Dashboard's day-annotations panel among them) ask for notes
     * and events over the exact same {from, to} this sweep's own Notes visit uses (both read the
     * same anchor and the same RANGE_KEYS), so by the time /notes is swept every one of its own
     * urls can already be in the manifest from an earlier page - a real, working page, recording
     * nothing NEW while still fetching and rendering correctly. `server.recorded.size` cannot tell
     * that apart from a page whose query silently never fired at all, which is the actual hole
     * this guard exists to catch; `successfulLandings` can, since a real fetch (new url or not)
     * always bumps a query's own `dataUpdateCount` on success. flush() throws on a tree that never
     * starts or never settles - that throw is left to propagate, per this task's own rule that a
     * page which will not settle is the finding, not something to catch and paper over.
     */
    async function mount(path: string, { expectGrowth = true } = {}): Promise<void> {
      const before = successfulLandings(client)
      // navigate(), not a raw window.history call: routes.tsx builds every ROUTES entry's
      // `.element` once, at module load, so `<Dashboard />` (and every other page) is the exact
      // same element object on every visit to '/'. React's reconciler bails out of re-rendering a
      // child it finds referentially identical to what it rendered there last time, which a raw
      // history write leaves nothing to defeat: nothing renders the tree in between, so the next
      // root.render() call reconciles top-down, meets that identical element at Dashboard's
      // position, and skips it - its own hooks, usePageControls among them, never run again, and
      // no new query ever fires. navigate() is what real in-app navigation already always goes
      // through, and it works there for exactly the reason this needs it too: it notifies
      // useSyncExternalStore's subscribers directly, which schedules React's update at the
      // subscribed component's OWN fiber (Dashboard's own usePageControls call, not merely
      // Shell's), bypassing the parent's bailout entirely.
      act(() => {
        navigate(path, { replace: true })
        root.render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
      })
      await flush(client, () => container.innerHTML)
      if (expectGrowth) {
        expect(successfulLandings(client), `${path} landed no successful query`).toBeGreaterThan(before)
      }
    }

    for (const route of ROUTES) {
      // A parameterised path can never be pushed as a real URL (there is no id to fill it with
      // yet) - the detail pages below handle WORKOUT_ROUTE and NIGHT_ROUTE once real ids exist.
      if (route.path.includes(':')) continue

      for (const [index, range] of RANGE_KEYS.entries()) {
        await mount(`${route.path}?range=${range}&on=${DEMO_DATE}`, {
          // Checked on every range, not only the first: a breakage confined to one preset (the
          // Year view, say) would otherwise go unnoticed. Settings is the one exception that still
          // needs one: unlike every other route here, it never calls usePageControls, so its five
          // range mounts genuinely ask for the same, already-fresh resources every time once the
          // first has run - only that first mount is owed new activity. /records (M6c) is in
          // the same position for a reason of its own: it is the one page with no control row
          // at all, because every figure on it is an all-time figure and a range picker there
          // would be a control that either lies or does nothing. Five range mounts therefore
          // ask for one already-cached resource, and only the first is owed a landing.
          // Nutrition never lands
          // anything, on any visit, by design: it renders one static sentence and calls no data
          // hook at all (Nutrition.tsx's own comment - the household never logged food, so there
          // is nothing here to ask a server for).
          expectGrowth: route.path !== '/nutrition'
            && (usesPageControls(route.path) || index === 0),
        })
      }
    }

    const wideFrom = addDays(DEMO_DATE, -(seededDays - 1))

    // Real source ids this seed produced, discovered from the server rather than guessed at:
    // `sourcesIn` is the exact parser the control row itself uses on a merged row's sourceMix, so
    // this asks the same question the app does instead of hardcoding what today's fixtures happen
    // to be named. heart_rate/mean, omitting `source`, is the one request in this whole sweep
    // guaranteed to carry a real mix on every point that has one at all (rollup.ts writes
    // sourceMix null on every per-source row; only a merged row - the all-sources sentinel query -
    // carries one, per pageShell.ts's own comment on distinctSources).
    const mixReply = await server.fetch(
      `/api/v1/p/${server.personId}/series?agg=mean&metric=heart_rate&from=${wideFrom}&to=${DEMO_DATE}`,
    )
    const mixBody = await mixReply.json() as Record<string, MetricSeries>
    const discoveredSources = new Set<string>()
    for (const series of Object.values(mixBody)) {
      for (const point of series.points) {
        for (const source of sourcesIn(point.sourceMix)) discoveredSources.add(source)
      }
    }
    discoveredSources.delete(ALL_SOURCES)
    expect(discoveredSources.size, 'the seed produced no per-source rows to discover a picker option from')
      .toBeGreaterThan(0)

    // Ruling B, dimension 1: every source option a picker actually offers, not only the default
    // (ALL_SOURCES itself is already covered by the grid above).
    for (const path of SOURCE_ROUTES) {
      for (const range of RANGE_KEYS) {
        for (const source of discoveredSources) {
          await mount(`${path}?range=${range}&on=${DEMO_DATE}&source=${source}`)
        }
      }
    }

    // Ruling B, dimension 2: one step back AND two steps back per range preset, so "previous
    // week"/"previous month" are in the manifest, and so is the anchor one more click past them -
    // every route that reads a range at all, at the default source. Two steps, not one: the
    // critical review's own finding is that ControlRow's back chevron reaches a nothing-recorded
    // anchor in exactly two clicks (record.tsx used to step the anchor back only once), and the
    // fix is to widen the sweep to match rather than to paper over the third click's miss.
    for (const route of ROUTES) {
      if (route.path.includes(':') || !usesPageControls(route.path)) continue
      for (const range of RANGE_KEYS) {
        let anchor = DEMO_DATE
        for (let step = 0; step < 2; step += 1) {
          anchor = stepAnchor(range, anchor, -1)
          await mount(`${route.path}?range=${range}&on=${anchor}`)
        }
      }
    }

    // Detail pages: every night and session the default Week and Month lists actually show,
    // rather than a fixed handful of the most recent. The critical review's own finding: the Sleep
    // list's default Week view lists 7 nights while a hardcoded slice(0, 5) captured a detail page
    // for only 5 of them, leaving the other 2 one click away from a manifest miss that used to
    // render as "the instance returned an error" - and a night's own detail page issues its own,
    // single-day {from: localDate, to: localDate} query, a different canonical url from the list's
    // own {from, to} range, so being IN the list response is not enough to make its detail page
    // reachable. Week and Month, not just one: Activity's and Sleep's own default range is
    // whichever a visitor lands on, and the two are exactly the presets ControlRow's segmented
    // control (RANGE_KEYS) offers a click away from each other with no anchor step at all.
    const weekWindow = datesFor('week', DEMO_DATE)
    const monthWindow = datesFor('month', DEMO_DATE)

    async function sessionsIn(range: { from: string, to: string }): Promise<WorkoutSession[]> {
      const reply = await server.fetch(
        `/api/v1/p/${server.personId}/sessions?kind=exercise&from=${range.from}&to=${range.to}`,
      )
      const { items } = await reply.json() as { items: WorkoutSession[] }
      return items
    }

    async function nightsIn(range: { from: string, to: string }): Promise<Night[]> {
      const reply = await server.fetch(
        `/api/v1/p/${server.personId}/sleep/nights?from=${range.from}&to=${range.to}`,
      )
      const { items } = await reply.json() as { items: Night[] }
      return items
    }

    // Deduplicated by id/localDate, not concatenated: the Month window contains the Week window's
    // own days whenever the anchor's week does not cross a month boundary, and mounting the same
    // detail page twice would only cost time, not coverage - but this way it costs neither.
    const sessions = [...new Map(
      [...await sessionsIn(weekWindow), ...await sessionsIn(monthWindow)].map((s) => [s.id, s]),
    ).values()]
    expect(sessions.length, 'the seed produced no exercise sessions in the default week/month views')
      .toBeGreaterThan(0)
    for (const session of sessions) await mount(WORKOUT_ROUTE.replace(':sessionId', session.id))

    const nights = [...new Map(
      [...await nightsIn(weekWindow), ...await nightsIn(monthWindow)].map((n) => [n.localDate, n]),
    ).values()]
    expect(nights.length, 'the seed produced no nights in the default week/month views').toBeGreaterThan(0)
    for (const night of nights) await mount(NIGHT_ROUTE.replace(':localDate', night.localDate))

    // The manifest itself still has to be non-empty (writeCapture's own refusal), which is a
    // stricter, whole-sweep fact that every per-mount landing check above cannot by itself
    // guarantee (a landing can, in principle, be a response `recorded` never sees - though nothing
    // in this app answers a GET with anything but JSON today).
    expect(server.recorded.size).toBeGreaterThan(0)

    act(() => { root.unmount() })
    container.remove()

    const report = writeCapture(outDir, server.recorded)
    // A synchronous file write, not a marked console line - see this file's own header comment
    // and capture-demo.mjs's own comment on reportFile for the stdout race a line could lose.
    writeFileSync(reportFile, JSON.stringify(report))
  }, 30 * 60_000)
})
