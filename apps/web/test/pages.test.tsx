// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { EChartsOption } from 'echarts'
import { dayMetricTarget } from '@haelan/core/target-key'
import { Dashboard } from '../src/pages/Dashboard.js'
import { Activity } from '../src/pages/Activity.js'
import { Recovery } from '../src/pages/Recovery.js'
import { Sleep } from '../src/pages/Sleep.js'
import { Health } from '../src/pages/Health.js'
import { Weight } from '../src/pages/Weight.js'
import { Nutrition } from '../src/pages/Nutrition.js'
import { Notes } from '../src/pages/Notes.js'
import { Settings } from '../src/pages/Settings.js'
import { Account } from '../src/pages/Account.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { I18nProvider } from '../src/i18n/index.js'
import { seriesPoint, insightBody } from './metricCoverage.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason dashboard-round-trip.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Delegates to the real `echarts.init`, so every chart in this file still paints a real SVG into
 * its host div exactly as it would outside a test, and taps only `.on` to remember whichever
 * handler was registered for `'click'`.
 *
 * A full replacement stub (mocking `setOption`/`dispose`/`resize` too, this function's own first
 * version) silently disarmed four of this file's own assertions: `chart.setOption` never running
 * means the host div's `role="img"` element stays empty, so `not.toMatch(/>(null|undefined|NaN)</)`,
 * `not.toContain('NaN')` and "renders no raw message key" all scan zero chart output across all
 * four pages instead of the rendered SVG (including every markLine `name`, which is exactly where
 * this task's own annotation text lands). Measured directly: before this file mocked echarts.init
 * at all, all 35 chart hosts across the four pages contained a rendered `<svg>`; with the full
 * stub, all 35 were empty strings. Delegating restores every one of them while still letting the
 * one test that needs it (`annotate wiring`, below) capture the click handler without asking
 * zrender to resolve a coordinate against a rendered SVG, which chart-marks.test.tsx already
 * established does not work under happy-dom no matter how the click is simulated.
 *
 * `lastOption` rides along the same tap, for the same reason and the same constraint: the weight
 * trend test below (`Weight specifics`) needs to see the real `series` array a chart was actually
 * given, not only that something painted, and re-deriving that from the rendered SVG's own path
 * data would be asserting against echarts' internal drawing rather than against what this
 * component built. `chart.setOption` still runs for real underneath the tap, so the SVG every
 * other assertion in this file depends on is unaffected.
 */
type CapturedChart = { onClick?: (event: unknown) => void, lastOption?: EChartsOption }
const capturedCharts: CapturedChart[] = []

vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    init: (...args: unknown[]) => { on: (...a: unknown[]) => unknown, setOption: (...a: unknown[]) => unknown }
  } & Record<string, unknown>
  return {
    ...actual,
    init: (...args: unknown[]) => {
      const chart = actual.init(...args)
      const entry: CapturedChart = {}
      capturedCharts.push(entry)
      const originalOn = chart.on.bind(chart)
      chart.on = (eventName: unknown, handler: unknown) => {
        if (eventName === 'click') entry.onClick = handler as (event: unknown) => void
        return originalOn(eventName, handler)
      }
      const originalSetOption = chart.setOption.bind(chart)
      chart.setOption = (option: unknown, ...rest: unknown[]) => {
        entry.lastOption = option as EChartsOption
        return originalSetOption(option, ...rest)
      }
      return chart
    },
  }
})

/** The function useChart.ts actually passed to `chart.on('click', ...)`, i.e. `handleClick`. */
function clickHandlerOf(entry: CapturedChart): (event: unknown) => void {
  if (!entry.onClick) throw new Error('chart.on was never called with "click"')
  return entry.onClick
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const RANGE = '/dashboard?range=week&on=2026-08-12'
// Four of the week's seven days report, so the tables have absences to render and every basis
// line has a denominator larger than its numerator. One heart rate day carries the smallest
// coverage the derivation can write, so the range chart has a day it can honestly call unworn.
// None of that existed in the render this file used to assert against, which resolved nothing.
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']
const UNWORN_DAY = '2026-08-11'
// The Day tab, anchored on the last of DAYS' own four dates so the stub's /series (filtered to
// the requested from/to, see stubFetch's own comment) answers with real data for it rather than
// an empty range that would leave every assertion below indistinguishable from a genuinely quiet
// day.
const DAY_ROUTE = '/dashboard?range=day&on=2026-08-13'
// Health's own Day tab, on the same anchor and for the same reason. Dashboard alone was mounted
// here while five other pages carried the same flag, which is how Health.tsx shipped without it:
// a second page settled on this range is what makes the Day tab tests below a claim about the
// app rather than about one file.
const HEALTH_DAY_ROUTE = '/health?range=day&on=2026-08-13'

/**
 * A week of real answers. The page used to be asserted against a render that never resolved a
 * single query, which meant every invariant below was checked against four zeroed stat tiles and
 * a heatmap domain of "0 to 0": the one test that named the rule ("never renders absence as a
 * zero") looked only for the presence of a word elsewhere on the page and could not fail.
 *
 * `overrides`/`notes`/`events` all default to none: every page now issues its own GET /overrides,
 * /notes and /events through useAnnotations, and the four page describes below assert a page that
 * carries none of the three, the same shape the override alone asserted before this task wired
 * the other two requests in. The tests that want a real row (see 'annotate wiring' and 'notes and
 * events reach the charts' below) pass their own lists.
 */
function stubFetch(
  overrides: readonly unknown[] = [], notes: readonly unknown[] = [], events: readonly unknown[] = [],
  trend: 'real' | 'none' = 'real',
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) {
      return json({
        running: false, lastFinishedAtMs: Date.now() - 600_000,
        rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] },
      })
    }
    if (url.includes('/overrides')) return json({ items: overrides })
    if (url.includes('/notes')) return json({ items: notes })
    if (url.includes('/events')) return json({ items: events })
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      // Real /series scopes every row to the requested from/to (personQuery's own requireRange),
      // and the Day tab tests below depend on that: a one day request has to come back with the
      // one DAYS entry inside it, not all four regardless of range, or a one day range could never
      // be told apart from a week from the response shape alone. Index (`i`) is kept off DAYS'
      // own position rather than the filtered array's, so a day's stubbed value stays the same
      // number whichever range it is requested under.
      const from = params.get('from') ?? ''
      const to = params.get('to') ?? ''
      const body: Record<string, unknown> = {}
      for (const metric of params.getAll('metric')) {
        body[metric] = {
          points: DAYS
            .map((date, i) => ({ date, i }))
            .filter(({ date }) => date >= from && date <= to)
            .map(({ date, i }) => seriesPoint(
              metric, date, metric.startsWith('sleep_') ? 420 + i * 5 : 60 + i * 7,
              {
                // The one day heart rate is at the derivation's coverage floor, which is what gives
                // the wear clause a singular to render (see the unworn day assertions below).
                ...(metric === 'heart_rate' && date === UNWORN_DAY ? { coverage: 1 / 24 } : {}),
                sourceMix: JSON.stringify([{ source: 'watch', hours: 24 }]),
                // Null is as real on the wire as a stamp is (personQuery.ts: a row derived before
                // M3b added the column), and this is the one stub that exercises that half.
                updatedAtMs: null,
              },
            )),
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/intraday')) {
      // Two samples spread across the requested day, real enough that IntradayHeartRate draws a
      // trace rather than folding into its own no-data branch: the day tab tests need a chart to
      // find absent, not a fresh empty state standing in for it.
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const date = params.get('date') ?? '2026-08-13'
      return json({
        points: [
          { sourceId: 'watch', utcMs: Date.parse(`${date}T08:00:00Z`), min: 58, mean: 62, max: 70 },
          { sourceId: 'watch', utcMs: Date.parse(`${date}T20:00:00Z`), min: 60, mean: 65, max: 74 },
        ],
        reduction: null,
      })
    }
    if (url.includes('/sleep/nights')) {
      const start = Date.parse('2026-08-12T23:00:00Z')
      return json({
        items: [{
          localDate: '2026-08-13', sourceId: 'watch', sessionIds: ['s1'],
          startMs: start, endMs: start + 7 * 3_600_000,
          startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], excludedSessions: [],
          segments: [
            { stage: 'LIGHT', startMs: start, endMs: start + 3_600_000 },
            { stage: 'DEEP', startMs: start + 3_600_000, endMs: start + 3 * 3_600_000 },
            { stage: 'REM', startMs: start + 3 * 3_600_000, endMs: start + 7 * 3_600_000 },
          ],
        }],
        cursor: null,
      })
    }
    if (url.includes('/insights')) return json(insightBody(url))
    // Weight's own trend line only (Weight.tsx wires useTrend to the weight metric alone), same
    // DAYS-filtered-by-from/to shape as the /series branch above, so the two stay coherent: a day
    // /series answers for is a day /trend can smooth too. Values an order of magnitude away from
    // /series' own 60 + i*7, so a settled render cannot pass the "draws a second series" check
    // below by coincidentally reusing the readings' own numbers, and so the trend column's own
    // cells in the accessible table are legible apart from the reading cells beside them: these
    // are grams, and 50000 + i*3000 formats to a distinct 50.0, 53.0, 56.0, 59.0 in the kilograms
    // the weight card displays, where the readings all round to the same 0.1.
    //
    // `trend: 'none'` answers the same route with no points at all, which is what trendOf really
    // sends for a range holding fewer than TREND_MIN_POINTS readings (packages/core/src/query/
    // trend.ts) and the same dense-but-all-null array the page builds while the request is in
    // flight or after it failed. Weight.tsx hands that array over regardless, so it is the shape
    // the "no trend to draw" tests below need and the one nothing here could produce before.
    if (url.includes('/trend')) {
      if (trend === 'none') return json({ points: [] })
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const from = params.get('from') ?? ''
      const to = params.get('to') ?? ''
      const points = DAYS
        .map((date, i) => ({ date, i }))
        .filter(({ date }) => date >= from && date <= to)
        .map(({ date, i }) => ({ localDate: date, value: 50_000 + i * 3_000 }))
      return json({ points })
    }
    return json({ baseline: { center: 62, spread: 4, n: 40, thin: false } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

// One path and anchor per page, sharing Dashboard's own week and gap (2026-08-10 through -16,
// only four of the seven days answering): the same partial week that gives every basis line on
// Dashboard a denominator bigger than its numerator does the same for whichever cards Activity,
// Recovery and Sleep draw from the identical DAYS array stubFetch answers every /series call with.
const ACTIVITY_ROUTE = '/activity?range=week&on=2026-08-12'
const RECOVERY_ROUTE = '/recovery?range=week&on=2026-08-12'
const SLEEP_ROUTE = '/sleep?range=week&on=2026-08-12'
const HEALTH_ROUTE = '/health?range=week&on=2026-08-12'
const WEIGHT_ROUTE = '/weight?range=week&on=2026-08-12'
const NOTES_ROUTE = '/notes?range=week&on=2026-08-12'
// No range or anchor query params: neither page calls usePageControls, so these are real paths
// for window.history.replaceState to carry and nothing in either reads a range back. Settings does
// read one thing off its own path - which tab is open - and it is pinned to the instance tab here
// on purpose: it is the tab whose two cards are ordinary cards, so the assertions below about card
// markup have something to look at. The members tab's one card is `measured`, which the card regex
// in this file deliberately does not match.
const SETTINGS_ROUTE = '/settings?tab=instance'
const ACCOUNT_ROUTE = '/account'

/**
 * Mounts one page for real, waits for every query to settle, and returns the settled markup.
 *
 * Extracted out of what used to be Dashboard's own `settledDashboard`, once Activity, Recovery and
 * Sleep needed byte identical mount/flush/unmount plumbing around three different components: a
 * fourth copy of this function differing only in which component it renders was the same shape
 * pageShell.ts already exists to rule out one level up, just not yet written down at this level.
 */
async function settledPage(Page: () => ReactNode, route: string, lng: string): Promise<string> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  window.history.replaceState(null, '', route)
  const tree: ReactNode = (
    <I18nProvider lng={lng}><QueryClientProvider client={client}><Page /></QueryClientProvider></I18nProvider>
  )
  act(() => { root.render(tree) })
  await flush(client, () => container.innerHTML)
  const html = container.innerHTML
  act(() => { root.unmount() })
  container.remove()
  return html
}

const settledDashboard = (lng: string) => settledPage(Dashboard, RANGE, lng)
const settledActivity = (lng: string) => settledPage(Activity, ACTIVITY_ROUTE, lng)
const settledRecovery = (lng: string) => settledPage(Recovery, RECOVERY_ROUTE, lng)
const settledSleep = (lng: string) => settledPage(Sleep, SLEEP_ROUTE, lng)
const settledHealth = (lng: string) => settledPage(Health, HEALTH_ROUTE, lng)
const settledWeight = (lng: string) => settledPage(Weight, WEIGHT_ROUTE, lng)
const settledNotes = (lng: string) => settledPage(Notes, NOTES_ROUTE, lng)
const settledSettings = (lng: string) => settledPage(Settings, SETTINGS_ROUTE, lng)
const settledAccount = (lng: string) => settledPage(Account, ACCOUNT_ROUTE, lng)

const restore = stubFetch()
// Sleep used to leave this harness once it went off fixtures (M3d2): a review round afterwards
// found that Activity and Recovery, converted off fixtures in the two tasks before Sleep, had
// never been added here either, so three new pages and twenty odd new cards sat outside every
// assertion below. Eight of these nine settle for real now through the same stubFetch week,
// rather than excluding a whole page because one of its charts cannot answer every assertion (see
// HAS_ABSENCE_CHART and IS_CHART_PAGE below for the assertions that genuinely do not apply to
// every page). Settings and Notes are the two of those eight with no chart and no delta at all,
// not a page whose chart happens not to draw absences, which is why both get their own named
// carve-out rather than reusing HAS_ABSENCE_CHART's.
//
// Nutrition is the ninth and is not settled through settledPage: it issues no query at all
// (Nutrition.tsx's own doc comment: there is no catalogue entry to fetch), so flush() would sit
// out its whole HANG_BUDGET_MS waiting for a fetch that is never coming and then throw, rather
// than the "sawFetch never armed" case flush.ts's own comment already names for a click that
// resolves inside the act() that fired it. renderToStaticMarkup needs nothing settled, since
// there is nothing for this page to load in the first place, only a translation table, and
// I18nProvider is the only context Nutrition.tsx actually reads.
const pages = {
  Dashboard: await settledDashboard('en'),
  Activity: await settledActivity('en'),
  Recovery: await settledRecovery('en'),
  Sleep: await settledSleep('en'),
  Health: await settledHealth('en'),
  Weight: await settledWeight('en'),
  Nutrition: renderToStaticMarkup(<I18nProvider lng="en"><Nutrition /></I18nProvider>),
  Notes: await settledNotes('en'),
  Settings: await settledSettings('en'),
  // The sections that used to make up most of Settings, on the page they moved to. Listed here
  // for the same reason Settings is: this battery is where a page's own markup is held to the
  // app's rules, and a split that left the account sections out of it would quietly drop five
  // cards' worth of coverage.
  Account: await settledAccount('en'),
}
const dashboardNl = await settledDashboard('nl')
// Settled inside the same stub window as `pages`/`dashboardNl` above, rather than inside an `it`
// after `restore()` runs below: every other settledPage call in this file happens while stubFetch
// is installed, and the Day tab tests want the same real, resolved render those already get, not
// a fresh mount racing the unstubbed global fetch.
const dashboardDay = await settledPage(Dashboard, DAY_ROUTE, 'en')
const healthDay = await settledPage(Health, HEALTH_DAY_ROUTE, 'en')
restore()

// Whether a page carries at least one dense, by-position chart that draws an explicit absence
// mark for a calendar day nothing answered (Dashboard's HeartRateRange, Activity's own steps
// heatmap). An ordinary Sparkline, which is every per-metric tile chart on Recovery and Sleep,
// builds its accessible table straight from the points a query actually returned (SeriesPoint.value
// is never null, so there is no gap value to render a word for; see useSeries.ts's own comment),
// not from a dense day-by-day array with a placeholder for the days it left out. Sleep's other two
// charts (Hypnogram, SleepSchedule, added this task) are not Sparklines but are not dense
// by-position calendar charts either: a hypnogram draws the one night a query actually returned,
// and a schedule row exists only for a night a query actually returned, neither drawing a fixed
// calendar position with a placeholder for a day nothing answered. So a gapped week changes how
// many rows any of these charts' tables have, never what a missing one says, and "not worn"/
// "no reading" can never appear in either page's markup no matter what the stub answers. This is
// not a coverage question either: none of Recovery's three metrics carries a wear signal
// (Recovery.tsx's own card() comment) and neither does any sleep metric (emptyState.ts's own
// coverageIsWearSignal), so even a wear-signal-capable metric drawn this way would still say
// nothing, the same reason Activity's own distance and floors cards cannot either despite steps,
// right beside them, being able to through the one chart that draws densely.
//
// Health is true for the same reason Dashboard's heart rate range card is: Spo2Range (Health.tsx)
// is built the same way HeartRateRange is, one day per date in the range looked up by localDate
// with a null left where a request answered nothing, and it draws the same markPoint/markLine
// absence marks HeartRateRange does over that gap. Unlike Recovery's three metrics, spo2 is also
// an intraday metric (packages/core/src/api/catalogue.ts: tier 'intraday'), so it carries a real
// wear signal too, giving the range card two independent ways to state an absence rather than none.
//
// Weight is false for the same reason Recovery and Sleep are: both its cards are plain Sparklines,
// built `episodic` (Weight.tsx's own card() comment), which drops a silent day from the accessible
// table entirely rather than rowing it with an absence word (Sparkline.tsx's own `episodic` prop
// comment). Neither weight nor body_fat carries a wear signal either (packages/core/src/api/
// catalogue.ts gives both no tier override, so they default to 'daily'), so there is no second way
// for this page to state an absence the way Health's spo2Range card can.
//
// Every gate built on a map like this one is read as `=== false`, never as `!value`: `!undefined`
// is true, so a page missing from the map would silently skip rather than run, and a page added to
// `pages` without a matching entry here would inherit an exemption nobody wrote down. `=== false`
// requires the exemption to be spelled out; anything absent runs the assertion instead.
//
// Notes is false for the same structural reason Settings is: it draws no `role="img"` chart host
// at all (its own table is an ordinary list, not a chart's `sr-only` accessible table), so there
// is no dense by-position calendar for an absence mark to land on. Nutrition joins them for the
// same reason again, one level plainer still: its one Card holds a single static EmptyState
// paragraph, no table of any kind.
const HAS_ABSENCE_CHART: Record<string, boolean> = {
  Dashboard: true, Activity: true, Recovery: false, Sleep: false, Health: true, Weight: false,
  Nutrition: false, Notes: false, Settings: false, Account: false,
}

// Whether a page carries any chart (and, riding on the same StatTile/MetricCard machinery, any
// delta) at all. Settings has neither: it is a table, not a metric page, so "names every chart"
// and "states the window every delta compared" have nothing to check on it and are gated here by
// name rather than by leaving Settings out of `pages` entirely, the same instinct HAS_ABSENCE_CHART
// above already states for a narrower case (a page with charts that just do not draw absences).
// Notes joins Settings here for the same reason: a list of notes and events is not a metric card,
// so it draws no StatTile and no delta either. Nutrition joins both: its single EmptyState is not
// a metric card either, and unlike Notes and Settings it draws no query of any kind (its own doc
// comment says why), so there is nothing here for it to summarise a change against. Read as
// `=== false` at each call site, not `!value`, for the same reason HAS_ABSENCE_CHART is: an
// unlisted page must run the assertion, not skip it by omission.
const IS_CHART_PAGE: Record<string, boolean> = {
  Dashboard: true, Activity: true, Recovery: true, Sleep: true, Health: true, Weight: true,
  Nutrition: false, Notes: false, Settings: false, Account: false,
}

// Everything inside the accessible tables, which is where a chart's own numbers and absence words
// live. Asserting against the whole page cannot tell a chart's table apart from a card's basis
// line, which is how "translates absence words" passed while every chart table stayed English.
function tables(html: string): string {
  return [...html.matchAll(/<table class="sr-only">[\s\S]*?<\/table>/g)].map((m) => m[0]).join('\n')
}

describe.each(Object.entries(pages))('%s', (_name, html) => {
  // Gated on IS_CHART_PAGE, not left to run unconditionally: Settings carries no chart at all
  // (a table is not a chart, and draws no role="img" host), so "at least one" would be a false
  // claim about it rather than a broken one.
  it.skipIf(IS_CHART_PAGE[_name] === false)('names every chart and points it at a description', () => {
    const hosts = [...html.matchAll(/<div[^>]*role="img"[^>]*>/g)].map((m) => m[0])
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) {
      expect(host, host).toMatch(/aria-label="[^"]+"/)
      expect(host, host).toMatch(/aria-describedby="[^"]+"/)
    }
  })

  it('resolves every aria-describedby to an element that exists', () => {
    for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) {
      expect(html, `no element with id ${m[1]}`).toContain(`id="${m[1]}"`)
    }
  })

  it('gives every chart a table alternative', () => {
    const charts = [...html.matchAll(/role="img"/g)].length
    const tableCount = [...html.matchAll(/<table class="sr-only">/g)].length
    expect(tableCount).toBe(charts)
  })

  it('never renders a null, undefined or NaN into the page', () => {
    expect(html).not.toMatch(/>(null|undefined|NaN)</)
    expect(html).not.toContain('NaN')
  })

  // The Critical MetricCard shipped once it owned the Card shell: giving Card a basis unconditionally
  // on top of a tile card that already prints one through its own StatTile put the same sentence on
  // the page twice, the second copy carrying the delta clause the first lacked. Cards do not nest in
  // this markup, so a non-greedy match up to the next closing section stays inside one card's own
  // subtree.
  it('draws at most one basis line per card', () => {
    const cards = [...html.matchAll(/<section class="card"[^>]*>[\s\S]*?<\/section>/g)].map((m) => m[0])
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      const basisLines = [...card.matchAll(/<p class="basis"/g)].length
      expect(basisLines, card).toBeLessThanOrEqual(1)
    }
  })

  // The half of the rule every page can be held to regardless of which chart it draws: no
  // headline value is the zero a formatter produces when it is handed nothing to summarise.
  it('never renders a zero for an absent value', () => {
    expect(html).not.toMatch(/<div class="value">0(<|&nbsp;| )/)
  })

  // The other half, only for a page carrying a chart that can actually say it: a day with no row
  // shows a word in that chart's own table alternative. See HAS_ABSENCE_CHART's own comment for
  // why Recovery and Sleep are excluded by name rather than by leaving the whole page out of this
  // describe.each the way the review round that added them here was asked not to repeat.
  it.skipIf(HAS_ABSENCE_CHART[_name] === false)('states absence in the accessible table, not silently', () => {
    expect(tables(html)).toMatch(/not worn|no reading/)
  })

  // These nine pages carry most of the catalogue, so a mistyped key would otherwise render as
  // literal text like "dashboard.foo.bar" and every assertion above would still pass: none of
  // them look for the shape a missing translation actually takes. settings and annotate joined
  // this list with Settings (M3c-12): AnnotatePanel's own keys never reach this file's settled,
  // no-click renders, but a page with settings.* copy now does, and a namespace absent here is a
  // namespace this test cannot see break. health joined with Health, weight joined with Weight,
  // the same reason both times. notes joined with Notes too, but this stub answers notes and
  // events empty, so Notes settles into its own empty state here and this alternation only ever
  // sees notes.title, notes.list.title and notes.empty.*: a typo in notes.columns.*, notes.remove,
  // notes.removing or notes.removeAria ships green through this file regardless. Those render only
  // once rows exist, so notes-page.test.tsx is where they are actually pinned, the same way this
  // file leaves AnnotatePanel's own click-triggered keys to annotate-panel.test.tsx. nutrition
  // joined with Nutrition: its whole render is nutrition.title and nutrition.empty.*, nothing
  // conditional on a query answering, so this one alternation sees every key it has.
  //
  // [a-zA-Z0-9], not [a-zA-Z]: a key path segment can carry a digit (health.spo2Range,
  // health.dailySpo2, charts.spo2Tooltip all do), and the letters-only class could not see past
  // one. Renaming health.spo2Range.label to a raw key used to render
  // `<span class="label">health.spo2Range.label</span>` straight into the settled HTML with this
  // test still green, because "spo2Range" broke the match at the digit and the regex never
  // resumed past it.
  it('renders no raw message key', () => {
    expect(html).not.toMatch(/\b(dashboard|sleep|common|charts|activity|recovery|health|weight|nutrition|notes|controlRow|emptyState|errorState|settings|annotate)\.[a-zA-Z0-9][a-zA-Z0-9.]*\b/)
  })

  // Both of these ran against Dashboard alone until the review that spotted three more pages had
  // joined the sweep without them: Activity carries eleven labelled cards and Sleep thirteen, all
  // of them outside a rule about labels being distinguishable and a rule about a delta stating the
  // window it compared.
  it('does not label two different cards with the same name', () => {
    const labels = [...html.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1])
    expect(labels.length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(labels.length)
  })

  // Gated the same way as the chart assertion above: Settings has no StatTile and so no delta at
  // all, and "at least one delta" would be a false claim about a page that draws none.
  // Asked per card rather than as a count over the page, which is what it used to be.
  //
  // One sentence per badge was a proxy for the thing actually worth holding - that a reader
  // looking at a delta can see what it compared - and it stopped being true the moment a card
  // carried more than one tile. Activity's zone minutes card holds three, and StatTile's own
  // `basis` prop exists for exactly that case: the shared sentence moves up to the card and is
  // said once instead of three times, which pages.test.tsx's own "at most one basis line per card"
  // requires in the same breath. The two assertions were in direct contradiction, and a count
  // could not tell "three badges sharing one sentence" apart from "two badges whose sentence is
  // missing".
  //
  // So: every card that draws a delta must state a window somewhere inside itself. That is
  // stronger than the count in the way that matters (it checks the sentence is in the same card as
  // the badge, which the page-wide count never did) and weaker only in allowing badges to share.
  it.skipIf(IS_CHART_PAGE[_name] === false)('states the window every delta compared', () => {
    // Cards do not nest, so splitting on the opening tag gives one chunk per card.
    const cards = html.split('<section class="card').slice(1)
    const WINDOW = /change is the mean of the last (\d+) readings against the first (\d+)/g
    let deltas = 0
    let windows = 0
    for (const card of cards) {
      const badges = [...card.matchAll(/class="delta"/g)].length
      const stated = [...card.matchAll(WINDOW)]
      deltas += badges
      windows += stated.length
      if (badges > 0) {
        expect(stated.length, `a card draws ${badges} delta(s) and states no window`).toBeGreaterThan(0)
      }
      // A window comparing nothing against nothing is not a window. The old assertion counted
      // these on a page where every one of them read "the last 0 readings against the first 0".
      for (const window of stated) {
        expect(Number(window[1])).toBeGreaterThan(0)
        expect(Number(window[2])).toBeGreaterThan(0)
      }
    }
    // Both kept, so a page that quietly stopped drawing deltas at all cannot pass by having no
    // cards left to check.
    expect(deltas, 'a chart page should draw at least one delta').toBeGreaterThan(0)
    expect(windows, 'a chart page should state at least one window').toBeGreaterThan(0)
  })
})

describe('chart tables follow the active language', () => {
  // Every chart's accessible table used to be built from English literals regardless of the
  // active language, which meant a Dutch screen reader user got an English table on both pages.
  //
  // Weekday labels are not checked here any more: the only chart on either of these two pages
  // that carried a weekday column was the daily steps heatmap, and M3d2 moved it to Activity.tsx,
  // which this file's own round trip harness does not stub. Date and absence words still come
  // through every ordinary Sparkline and the heart rate range chart, both of which stay on
  // Dashboard, so they are still worth pinning here.
  it('translates column headers and absence words', () => {
    const nlTables = tables(dashboardNl)
    expect(nlTables).toContain('Datum')
    // In a chart table, not merely somewhere on the page: this used to be satisfied by a tile's
    // own basis line while every table below it stayed English.
    expect(nlTables).toContain('niet gedragen')
    expect(nlTables).toContain('geen meting')
    expect(nlTables).not.toContain('>Date<')
    expect(nlTables).not.toContain('not worn')
    expect(nlTables).not.toContain('no reading')
  })

  // Sleep's own stage name translation moved to sleep-page.test.tsx's "translates sleep stage
  // names through the shared sleep.stage keys, not a second set" alongside the rest of Sleep's
  // coverage, once Sleep left this file's static-render harness (see the comment above `pages`).
})

describe('Dashboard specifics', () => {
  const html = pages.Dashboard

  // The daily steps heatmap this used to check moved to Activity.tsx in M3d2, along with the
  // colour domain and "stronger colour is more steps" copy it drew; activity.test.tsx covers its
  // dense-denominator basis line directly rather than through this file's own round trip harness,
  // which stubs only Dashboard and Sleep.
  it('counts the basis against every calendar day in the period, not the days that answered', () => {
    // The stubbed week is seven calendar days and DAYS answers four of them, so every card reads
    // "4 of 7": the denominator is the range and the numerator is the rows the headline figure was
    // actually computed from.
    expect(html).toContain('4 of 7 days')
    expect(html).not.toMatch(/(\d+) of \1 days/)
  })

  // The numerator, which the denominator assertion above cannot see. Five wear-clause templates
  // led with the worn count against the dense calendar denominator, so heart rate read "mean, 3 of
  // 7 days, 1 day not worn" over a mean taken across all four reporting days: the stated count was
  // not the count the number came from, and nothing on the card said which of the two it was.
  // Falsifiable in the direction that matters, since reverting any of those templates to the worn
  // count brings 3 back for this exact fixture (heart_rate has one day at the coverage floor).
  it('leads with the days the figure was computed from, not the worn subset of them', () => {
    expect(html).toContain('4 of 7 days, 1 day not worn')
    expect(html).not.toContain('3 of 7 days')
  })

  // The wear clause was structurally always zero until the coverage fix, so it only ever rendered
  // its plural and nothing noticed it had no singular. The stubbed week reaches both in one
  // render: heart rate has exactly one day at the derivation's coverage floor, and steps has none.
  it('counts one unworn day in the singular and none in the plural', () => {
    expect(html).toContain('1 day not worn')
    expect(html).not.toContain('1 days not worn')
    expect(html).toContain('0 days not worn')
  })

  it('picks the Dutch singular and plural too, not one form for both', () => {
    expect(dashboardNl).toContain('1 dag niet gedragen')
    expect(dashboardNl).not.toContain('1 dagen niet gedragen')
    expect(dashboardNl).toContain('0 dagen niet gedragen')
  })

})

// With from === to the daily series holds one point, and emptyState's only guard is length === 0,
// so before this every metric card on all six pages drew a single dot on the Day tab. The daily
// chart's own accessible name is the discriminator: it is an existing catalogue string, so this
// assertion cannot be satisfied by whatever copy the new chart happens to get.
describe('Day tab', () => {
  it('replaces the daily range chart on a one day range', () => {
    expect(dashboardDay).not.toContain('Daily heart rate minimum, mean and maximum through')
  })

  // Every other MetricCard on this range (the four stat tiles, the sleep schedule chart) still
  // renders its StatTile, delta and basis line exactly as any other range does (see the next test);
  // only the chart each would otherwise draw is swapped for ChartNote's own short line. Heart rate
  // alone keeps an actual chart, because it alone has an intraday view to swap in instead. The
  // figure count is the assertion because it is what a reader actually sees change: this page draws
  // several fewer chart figures on the Day tab than it does on a week, the state this replaces.
  it('draws fewer chart figures on a one day range than on a week', () => {
    const dayFigures = (dashboardDay.match(/<figure/g) ?? []).length
    const weekFigures = (pages.Dashboard.match(/<figure/g) ?? []).length
    expect(dayFigures).toBeLessThan(weekFigures)
  })

  // The defect a figure count alone cannot see: an early implementation dropped `single_day` into
  // emptyStateFor's own gate, which meant MetricCard's existing early return fired for it exactly
  // as it does for no_data and not_worn, discarding the StatTile (the number, the delta and the
  // basis line) along with the chart on a range where none of the three were wrong. A reader on the
  // Day tab lost every figure on the page, not only the meaningless one-point charts. Steps is the
  // card under test because DAYS's own stubbed value for it is real and non-zero on 2026-08-13.
  it('keeps a plain metric card\'s own number on a one day range, only its chart goes', () => {
    const cards = [...dashboardDay.matchAll(/<section class="card"[^>]*>[\s\S]*?<\/section>/g)].map((m) => m[0])
    const steps = cards.find((c) => c.includes('>Steps<'))
    if (!steps) throw new Error('no Steps card in the Day tab render')
    expect(steps).toContain('<div class="value">')
    expect(steps).not.toContain('<figure')
  })

  // The distinction that matters and the one most likely to be got wrong: a one day range with a
  // value is not missing data. Rendering the no-data copy would state something false, which is why
  // this needs its own reason rather than reusing no_data.
  it('does not claim a day with data has no data', () => {
    expect(dashboardDay).not.toContain('No data yet')
  })

  // Health was the sixth page and the one this branch missed: both its cards passed no oneDayRange
  // at all, so on ?range=day the spo2 card still drew a one point Spo2Range under a label promising
  // a range "through {period}", and daily_spo2 still drew a one point Sparkline. Each chart's own
  // accessible name is the discriminator, the same one the Dashboard assertion above uses: they are
  // existing catalogue strings, so neither assertion can be satisfied by whatever copy replaces the
  // chart.
  it('replaces the spo2 range chart on a one day range', () => {
    expect(healthDay).not.toContain('Daily oxygen saturation minimum, mean and maximum through')
  })

  it('replaces the daily spo2 sparkline on a one day range', () => {
    expect(healthDay).not.toContain('Daily oxygen saturation summary through')
  })

  // Both cards, not one: a page that swapped the range chart and left the sparkline (or the other
  // way round) still passes each single assertion above on its own, and a figure count is what
  // catches the half done case. Health draws exactly two figures on a week and neither survives the
  // Day tab, so this is zero rather than merely fewer.
  it('draws no chart figures at all on a one day range, both cards swapped', () => {
    expect((healthDay.match(/<figure/g) ?? []).length).toBe(0)
    expect((pages.Health.match(/<figure/g) ?? []).length).toBeGreaterThan(1)
  })

  // The same distinction the Dashboard assertions above draw, restated for the page whose cards
  // are new to this: the number, its delta and the basis line all stay, only the chart goes, and a
  // day carrying real data is never described as empty.
  it('keeps the Health cards\' own numbers on a one day range', () => {
    expect(healthDay).toContain('<div class="value">')
    expect(healthDay).not.toContain('No data yet')
    expect(healthDay).toContain('A single day has no trend to plot.')
  })
})

// Task 11's own coverage: until this task every chart on every page was handed an empty
// annotations/excluded pair (Dashboard's own EMPTY, by name, with a comment calling it a
// milestone boundary) and no chart's onPointClick went anywhere, since no page held a target to
// open the panel with. Recovery, not Dashboard: three plain Sparklines and nothing else touching
// useChart, so the first entry captured after this test's own render is unambiguously
// resting_heart_rate's, the same reasoning that picked it for the round trip harness above never
// needed to state (nothing there clicks).
describe('annotate wiring', () => {
  const OVERRIDE_DATE = '2026-08-11'
  const OVERRIDE_METRIC = 'resting_heart_rate'
  const OVERRIDE_REASON = 'Watch left charging'

  async function mountRecoveryWithOverride(): Promise<{ html: string, clickResting: (event: unknown) => void, cleanup: () => void }> {
    const restore = stubFetch([{
      id: 'o1', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: OVERRIDE_DATE, metric: OVERRIDE_METRIC }),
      action: 'exclude', correctedValue: null, reason: OVERRIDE_REASON,
    }])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', RECOVERY_ROUTE)
    const chartsBefore = capturedCharts.length

    act(() => {
      root.render(
        <I18nProvider lng="en"><QueryClientProvider client={client}><Recovery /></QueryClientProvider></I18nProvider>,
      )
    })
    await flush(client, () => container.innerHTML)

    // resting_heart_rate is Recovery.tsx's own first card(), so the first chart entry captured by
    // this mount (capturedCharts already carries one entry per chart from the module level `pages`
    // harness above, hence the slice) is unambiguously its Sparkline, not daily_hrv's or
    // respiratory_rate's.
    const entry = capturedCharts.slice(chartsBefore)[0]
    if (!entry) throw new Error('no chart mounted')
    const clickResting = clickHandlerOf(entry)

    return {
      html: container.innerHTML,
      clickResting,
      cleanup: () => {
        act(() => { root.unmount() })
        container.remove()
        restore()
      },
    }
  }

  it('marks the excluded day in its own chart table rather than dropping it', async () => {
    const { html, cleanup } = await mountRecoveryWithOverride()
    try {
      // Recovery's first accessible table belongs to resting_heart_rate's own Sparkline, the same
      // card the override targets; daily_hrv and respiratory_rate get no mark, since the override
      // named a metric, not a day.
      const firstTable = html.match(/<table class="sr-only">[\s\S]*?<\/table>/)?.[0]
      if (!firstTable) throw new Error('no accessible table rendered')
      const row = firstTable.match(new RegExp(`<tr><th scope="row">${OVERRIDE_DATE}</th>[\\s\\S]*?</tr>`))?.[0]
      if (!row) throw new Error(`no row for ${OVERRIDE_DATE}`)
      // 67: DAYS' own resting_heart_rate value for 2026-08-11 (index 1, 60 + 1*7). Still present,
      // not replaced by an absence word: an override marks a reading, it does not remove it.
      expect(row).toContain('67')
      expect(row).toContain('excluded')
      expect(row).toContain(OVERRIDE_REASON)
      // The untouched day beside it carries neither mark.
      const otherRow = firstTable.match(/<tr><th scope="row">2026-08-10<\/th>[\s\S]*?<\/tr>/)?.[0]
      expect(otherRow, otherRow).not.toContain('excluded')
    } finally {
      cleanup()
    }
  })

  it('opens the panel with the clicked point’s own day and metric, typed by nobody', async () => {
    const { clickResting, cleanup } = await mountRecoveryWithOverride()
    try {
      // dataIndex 1 is DAYS[1], 2026-08-11: the same day the override above targets, clicked
      // through the chart rather than read off state a caller assembled by hand.
      act(() => { clickResting({ componentType: 'series', dataIndex: 1 }) })
      const containers = document.querySelectorAll('[role="dialog"]')
      expect(containers).toHaveLength(1)
      const dialogHtml = containers[0]!.innerHTML
      // annotate.title is "{{metric}} on {{date}}": this asserts the panel opened with the
      // clicked point's own metric and date, not a target the page had to build by hand
      // (AnnotatePanel.tsx builds the target key itself; a page only ever hands it these two
      // fields, see its own doc comment).
      expect(dialogHtml).toContain(`${OVERRIDE_METRIC} on ${OVERRIDE_DATE}`)
    } finally {
      cleanup()
    }
  })
})

// Task 11b's own coverage: until this task useAnnotations issued GET /notes and GET /events on
// every page and every range change and threw both away, the gap task-11b's own brief names.
// Recovery, the same choice 'annotate wiring' above makes and for the same reason: three plain
// Sparklines and nothing else on the page, so a note or an event landing on all three (or on
// none) is unambiguous, with no heatmap or heart rate range chart nearby to blur which card a mark
// actually reached.
describe('notes and events reach the charts', () => {
  const DATE = '2026-08-11'
  const NOTE_BODY = 'felt off today'

  async function mountRecoveryWithDayAnnotations(): Promise<{ html: string, cleanup: () => void }> {
    const restore = stubFetch(
      [],
      [{ id: 'n1', localDate: DATE, body: NOTE_BODY, updatedAtMs: 0 }],
      [{
        id: 'e1', kind: 'illness', startedAtMs: Date.parse(`${DATE}T09:00:00Z`), startedAtOffsetMinutes: 0,
        endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, localDate: DATE,
      }],
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', RECOVERY_ROUTE)

    act(() => {
      root.render(
        <I18nProvider lng="en"><QueryClientProvider client={client}><Recovery /></QueryClientProvider></I18nProvider>,
      )
    })
    await flush(client, () => container.innerHTML)

    return {
      html: container.innerHTML,
      cleanup: () => {
        act(() => { root.unmount() })
        container.remove()
        restore()
      },
    }
  }

  // The density judgment call task-11b's report states: a note or an event carries no metric of
  // its own (unlike an override), so it reaches every chart on the page rather than being
  // arbitrarily attached to whichever card happens to share its date. Recovery draws exactly
  // three cards, none of which the note or the event above targets by metric, so all three
  // carrying the same date's mark is the decision under test, not an accident of the fixture.
  it('carries a note onto every chart on the page, not just one', async () => {
    const { html, cleanup } = await mountRecoveryWithDayAnnotations()
    try {
      const chartTables = [...html.matchAll(/<table class="sr-only">[\s\S]*?<\/table>/g)].map((m) => m[0])
      expect(chartTables).toHaveLength(3)
      for (const t of chartTables) {
        const row = t.match(new RegExp(`<tr><th scope="row">${DATE}</th>[\\s\\S]*?</tr>`))?.[0]
        if (!row) throw new Error(`no row for ${DATE}`)
        expect(row, row).toContain(NOTE_BODY)
      }
    } finally {
      cleanup()
    }
  })

  // The note and the event share a date, so this also pins the multiplicity fix: both texts reach
  // the same row, joined, rather than one silently replacing the other the way a find() (instead
  // of the filter+join every chart table now uses) would.
  it('translates a seed event kind and joins it with a note sharing its date', async () => {
    const { html, cleanup } = await mountRecoveryWithDayAnnotations()
    try {
      const firstTable = html.match(/<table class="sr-only">[\s\S]*?<\/table>/)?.[0]
      if (!firstTable) throw new Error('no accessible table rendered')
      const row = firstTable.match(new RegExp(`<tr><th scope="row">${DATE}</th>[\\s\\S]*?</tr>`))?.[0]
      if (!row) throw new Error(`no row for ${DATE}`)
      expect(row).toContain(`${NOTE_BODY}, Illness`)
    } finally {
      cleanup()
    }
  })
})

// Task 6's own point, restated: task-6-brief.md's tests assert trendPath alone and nothing checks
// that the weight card actually draws the trend it builds, exactly the shape PersonQuery.trend
// shipped in already (specced and built, M3e-1 drew raw readings around it without a consumer).
// Mounted fresh, not read off the module level `pages.Weight` above: a dedicated mount keeps
// `chartsBefore` unambiguous (capturedCharts already carries one entry per chart from every page
// settled above by the time this describe runs) and lets "the weight card's own chart" below mean
// the first chart this specific mount captures, not however many charts every other page in this
// file happens to draw before it.
describe('Weight specifics', () => {
  async function mountWeightWithTrend(
    trend: 'real' | 'none' = 'real',
  ): Promise<{ html: string, series: EChartsOption['series'], cleanup: () => void }> {
    const restore = stubFetch([], [], [], trend)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', WEIGHT_ROUTE)
    const chartsBefore = capturedCharts.length

    act(() => {
      root.render(<I18nProvider lng="en"><QueryClientProvider client={client}><Weight /></QueryClientProvider></I18nProvider>)
    })
    await flush(client, () => container.innerHTML)

    // The weight card is Weight.tsx's own first card() call, ahead of body_fat, so the first chart
    // entry captured by this mount is unambiguously its Sparkline, the same ordinal reasoning
    // mountRecoveryWithOverride above states for Recovery's own first card.
    const entry = capturedCharts.slice(chartsBefore)[0]
    if (!entry) throw new Error('no chart mounted')

    return {
      html: container.innerHTML,
      series: entry.lastOption?.series,
      cleanup: () => {
        act(() => { root.unmount() })
        container.remove()
        restore()
      },
    }
  }

  it('draws the trend line as a second series, not instead of the readings', async () => {
    const { series, cleanup } = await mountWeightWithTrend()
    try {
      const list = Array.isArray(series) ? series as Record<string, unknown>[] : []
      // One series (the readings) before this task, on every other Sparkline caller still today;
      // two once the weight card's own trend query has data to draw, the readings kept rather than
      // replaced (see Sparkline.tsx's own `trend` prop comment for why the trend series is drawn
      // first, under the readings, rather than the readings dropped in its favour).
      expect(list).toHaveLength(2)
      expect(list[0]?.['smooth']).toBe(true)
    } finally {
      cleanup()
    }
  })

  // The two halves of the brief's own point 2 and point 3, checked from one render rather than
  // two: a fix that satisfies "draws a second series" (the test above) by swapping the readings
  // series for the trend line instead of adding to it would fail here on the missing series[1]
  // alone, and the basis assertion rides along on the same render as a regression guard, since
  // both readings.length and points.length come off the identical `metricGroups.pointsOf('weight')`
  // call in Weight.tsx's own card().
  it('keeps the readings drawn as points, and the basis still counting them, once the trend line is on the chart', async () => {
    const { series, html, cleanup } = await mountWeightWithTrend()
    try {
      const list = Array.isArray(series) ? series as Record<string, unknown>[] : []
      const readingsSeries = list[1]
      // showSymbol true is what actually draws a marker at every reading; a fix that painted only
      // the smooth trend line, the exact defect this task exists to rule out, would leave this
      // false (Sparkline's own default) or drop the readings series altogether.
      expect(readingsSeries?.['showSymbol']).toBe(true)
      // Dense over the whole week (WEIGHT_ROUTE spans 2026-08-10 through 2026-08-16, the same seven
      // day window RANGE gives Dashboard), not thinned down to the four days DAYS actually answers:
      // a reading series that dropped to four entries would be showing only the days with data,
      // which is what the accessible table does, not what the dense by-position canvas series does.
      expect(readingsSeries?.['data']).toHaveLength(7)

      const basis = [...html.matchAll(/<section class="card"[^>]*>[\s\S]*?<\/section>/g)]
        .map((m) => m[0])
        .find((card) => card.includes('>Weight<'))
        ?.match(/<p class="basis"[^>]*>([\s\S]*?)<\/p>/)?.[1]
      if (!basis) throw new Error('no basis line rendered for the Weight card')
      // Four of DAYS' own dates fall inside the week WEIGHT_ROUTE requests, the same count the
      // /series stub already answers for every other assertion against this fixture. M3e-1's own
      // decision (basis counts readings, not calendar days) has to survive the trend line landing
      // on the same card, not get displaced by it.
      expect(basis).toContain('4 readings this period')
      expect(basis).not.toMatch(/of \d+ days/)
    } finally {
      cleanup()
    }
  })

  // Weight.tsx passes `trend` unconditionally and weightTrend is always a defined dense array, so
  // "the prop is present" and "there is a line to draw" were never the same question. All-null is
  // the ordinary shape three ways: the query still in flight, the query failed, and a range holding
  // fewer than TREND_MIN_POINTS readings, which trendOf answers with nothing at all. Branching on
  // `trend !== undefined` still hid the readings' own line and switched them to bare symbols in all
  // three, so the card drew disconnected dots and no line, permanently, with nothing saying why.
  it('leaves the readings as an ordinary connected line when the trend has no points to draw', async () => {
    const { series, cleanup } = await mountWeightWithTrend('none')
    try {
      const list = Array.isArray(series) ? series as Record<string, unknown>[] : []
      // One series, not two: no smooth line was added, which is the same chart every other
      // Sparkline caller draws.
      expect(list).toHaveLength(1)
      const readingsSeries = list[0]
      // The two halves of the degradation, asserted separately because either alone would leave a
      // readable chart: bare symbols with a line still under them, or a hidden line with the
      // symbols off, is not what shipped. Both together is.
      expect(readingsSeries?.['showSymbol']).toBe(false)
      expect((readingsSeries?.['lineStyle'] as Record<string, unknown> | undefined)?.['opacity'])
        .toBeUndefined()
    } finally {
      cleanup()
    }
  })

  // The other half: the trend line had no representation in the accessible table at all, which
  // still carried date, value and note only. A table-only reader got the raw readings and nothing
  // of the line drawn through them, the same canvas-and-table split the band toggle one card away
  // exists to close.
  it('gives the trend line a column in the accessible table, in the reading\'s own unit', async () => {
    const { html, cleanup } = await mountWeightWithTrend()
    try {
      const table = [...html.matchAll(/<table class="sr-only">[\s\S]*?<\/table>/g)]
        .map((m) => m[0])
        .find((t) => t.includes('Weight in kilograms'))
      if (!table) throw new Error(`no weight chart table in:\n${html}`)
      expect(table).toContain('<th scope="col">Trend</th>')
      // Kilograms, through the card's own formatValue, not the raw grams the series carries: the
      // /trend stub answers 50000 grams for the first of DAYS' four dates, so that cell has to
      // read "50.0" and never "50000". A trend column formatted by anything but the reading cell's
      // own formatter would print grams beside kilograms under a header naming one of them, the
      // exact defect an M3e review already caught on Activity's distance card.
      expect(table).toContain('<td>50.0</td>')
      expect(table).not.toContain('<td>50000</td>')
      // Four cells per row now (date, reading, trend, note), not three: a column header added
      // without the cells beneath it would leave the header row and the body rows disagreeing.
      const bodyRows = [...table.matchAll(/<tr>(?:(?!<\/tr>)[\s\S])*<\/tr>/g)].map((m) => m[0])
      const dataRows = bodyRows.filter((row) => row.includes('<td>'))
      expect(dataRows.length).toBeGreaterThan(0)
      for (const row of dataRows) expect((row.match(/<td>/g) ?? []).length).toBe(3)
    } finally {
      cleanup()
    }
  })
})
