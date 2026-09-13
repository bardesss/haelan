// The sweep: mounts every page of the real app against a real, seeded instance (through
// startCaptureServer's app.inject() bridge, no port and no network) and records what each one
// asked for. This is what makes the demo's coverage a fact about the running app rather than a
// hand-written list - see the spec's own note on why the coverage guarantee follows from the
// sweep instead of from a separate list test.
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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../apps/web/src/Shell.js'
import { navigate } from '../../apps/web/src/router.js'
import { ROUTES, WORKOUT_ROUTE, NIGHT_ROUTE } from '../../apps/web/src/routes.js'
import { RANGE_KEYS, addDays } from '../../apps/web/src/controls/range.js'
import { CHART_VARS } from '../../apps/web/src/charts/tokens.js'
import { DEMO_INSTANT_MS } from '../../apps/web/src/demo/instant.js'
import { flush } from '../../apps/web/test/flush.js'
import { startCaptureServer } from './server.js'
import type { CaptureServer } from './server.js'
import { writeCapture } from '../../scripts/capture-demo.mjs'
import type { WorkoutSession } from '../../apps/web/src/data/useSessions.js'
import type { Night } from '../../apps/web/src/data/useNights.js'

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

// The Amsterdam calendar date DEMO_INSTANT_MS closes, derived rather than duplicated: instant.ts's
// own DEMO_END_DATE is private, and re-declaring the string here a second time is exactly the
// drift its own header comment warns about. DEMO_INSTANT_MS is exactly Amsterdam local midnight
// opening that date (localMidnightMs), so formatting it back in that zone recovers the date with
// no rounding to worry about.
const DEMO_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(DEMO_INSTANT_MS)

let server: CaptureServer
let restoreFetch: () => void

beforeAll(async () => {
  server = await startCaptureServer(dataDir)
  const original = globalThis.fetch
  globalThis.fetch = server.fetch
  restoreFetch = () => { globalThis.fetch = original }
  // Every request this sweep makes reads "now" as the same pinned instant the seed closed its
  // archive on - apiGet/apiSend never call Date.now() themselves, but the pages that call them
  // do (usePageControls' default anchor, sync status' "how long ago"), and a real clock here would
  // make a capture recorded today disagree with one recorded next month over what "today" means.
}, 120_000)

afterAll(() => {
  restoreFetch()
  server.close()
})

/**
 * How many queries in `client`'s cache have ever landed a real result. Counts `dataUpdateCount`
 * only, not `errorUpdateCount`: a query that only ever 400s or 404s contributed nothing to
 * `server.recorded` either (captureFetch's own refusals throw before it ever calls
 * `recorded.set`), so counting errors here would call a page that talks to the server and gets
 * nothing back the same "recorded something" that a page which actually got data is.
 */
function successfulLandings(client: QueryClient): number {
  return client.getQueryCache().getAll().reduce((total, query) => total + query.state.dataUpdateCount, 0)
}

describe('the capture sweep', () => {
  it('mounts every page and records what each one asks for', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    /**
     * Pushes `path` into history, mounts the real App tree fresh, and waits for it to settle,
     * then asserts the mount actually landed at least one successful query result.
     *
     * That guard is `successfulLandings` growing, not `server.recorded.size` growing: several
     * pages' own annotation overlays (Dashboard's day-annotations panel among them) ask for notes
     * and events over the exact same {from, to} this sweep's own Notes visit uses (both read the
     * same anchor and the same RANGE_KEYS), so by the time /notes is swept every one of its own
     * urls can already be in the manifest from an earlier page - a real, working page, recording
     * nothing NEW while still fetching and rendering correctly. `server.recorded.size` cannot
     * tell that apart from a page whose query silently never fired at all, which is the actual
     * hole this guard exists to catch; `successfulLandings` can, since a real fetch (new url or
     * not) always bumps a query's own `dataUpdateCount` on success. flush() throws on a tree that
     * never starts or never settles - that throw is left to propagate, per this task's own rule
     * that a page which will not settle is the finding, not something to catch and paper over.
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
          // Growth is only required on a route's first visit. Settings.tsx is the one page here
          // that reads no range at all (unlike every other route, it never calls
          // usePageControls), so its own resources are already fully known after the first of its
          // five range mounts - the same query keys, already fresh, are not owed a fetch just
          // because the URL's ignored `range` changed, and requiring one would fail a page that
          // is behaving exactly as designed. Nutrition never lands anything, even on its first
          // visit: it renders one static sentence and calls no data hook at all (Nutrition.tsx's
          // own comment - the household never logged food, so there is nothing here to ask a
          // server for), which is the one route in this table where that is correct rather than
          // the hole this guard exists to catch.
          expectGrowth: route.path !== '/nutrition' && index === 0,
        })
      }
    }

    // Detail pages: real ids and dates the seed actually produced, not invented ones. The range is
    // the seed's own full span so this finds sessions and nights regardless of where in the year
    // they happen to fall, and MAX_RANGE_DAYS (3660) comfortably covers it at any span this script
    // seeds.
    const from = addDays(DEMO_DATE, -(seededDays - 1))
    const sessionsReply = await server.fetch(
      `/api/v1/p/${server.personId}/sessions?kind=exercise&from=${from}&to=${DEMO_DATE}&limit=5`,
    )
    const { items: sessions } = await sessionsReply.json() as { items: WorkoutSession[] }
    expect(sessions.length, 'the seed produced no exercise sessions to capture a detail page for').toBeGreaterThan(0)
    for (const session of sessions) await mount(WORKOUT_ROUTE.replace(':sessionId', session.id))

    const nightsReply = await server.fetch(
      `/api/v1/p/${server.personId}/sleep/nights?from=${from}&to=${DEMO_DATE}&limit=5`,
    )
    const { items: nights } = await nightsReply.json() as { items: Night[] }
    expect(nights.length, 'the seed produced no nights to capture a detail page for').toBeGreaterThan(0)
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
  }, 20 * 60_000)
})
