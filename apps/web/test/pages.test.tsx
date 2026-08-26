// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Dashboard } from '../src/pages/Dashboard.js'
import { Activity } from '../src/pages/Activity.js'
import { Recovery } from '../src/pages/Recovery.js'
import { Sleep } from '../src/pages/Sleep.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { I18nProvider } from '../src/i18n/index.js'
import { coverageFor } from './metricCoverage.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason dashboard-round-trip.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

const RANGE = '/dashboard?range=week&on=2026-08-12'
// Four of the week's seven days report, so the tables have absences to render and every basis
// line has a denominator larger than its numerator. One heart rate day carries the smallest
// coverage the derivation can write, so the range chart has a day it can honestly call unworn.
// None of that existed in the render this file used to assert against, which resolved nothing.
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']
const UNWORN_DAY = '2026-08-11'

/**
 * A week of real answers. The page used to be asserted against a render that never resolved a
 * single query, which meant every invariant below was checked against four zeroed stat tiles and
 * a heatmap domain of "0 to 0": the one test that named the rule ("never renders absence as a
 * zero") looked only for the presence of a word elsewhere on the page and could not fail.
 */
function stubFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: Date.now() - 600_000 })
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const body: Record<string, unknown> = {}
      for (const metric of params.getAll('metric')) {
        body[metric] = {
          points: DAYS.map((date, i) => ({
            localDate: date,
            source: 'merged',
            value: metric.startsWith('sleep_') ? 420 + i * 5 : 60 + i * 7,
            coverage: metric === 'heart_rate' && date === UNWORN_DAY ? 1 / 24 : coverageFor(metric),
            sourceMix: JSON.stringify([{ source: 'watch', hours: 24 }]),
            updatedAtMs: null,
          })),
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/sleep/nights')) {
      const start = Date.parse('2026-08-12T23:00:00Z')
      return json({
        items: [{
          localDate: '2026-08-13', sourceId: 'watch', sessionIds: ['s1'],
          startMs: start, endMs: start + 7 * 3_600_000,
          startOffsetMinutes: 120, endOffsetMinutes: 120,
          segments: [
            { stage: 'LIGHT', startMs: start, endMs: start + 3_600_000 },
            { stage: 'DEEP', startMs: start + 3_600_000, endMs: start + 3 * 3_600_000 },
            { stage: 'REM', startMs: start + 3 * 3_600_000, endMs: start + 7 * 3_600_000 },
          ],
        }],
        cursor: null,
      })
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

const restore = stubFetch()
// Sleep used to leave this harness once it went off fixtures (M3d2): a review round afterwards
// found that Activity and Recovery, converted off fixtures in the two tasks before Sleep, had
// never been added here either, so three new pages and twenty odd new cards sat outside every
// assertion below. All four settle for real now through the same stubFetch week, rather than
// excluding a whole page because one of its charts cannot answer every assertion (see
// HAS_ABSENCE_CHART below for the one assertion that genuinely does not apply to every page).
const pages = {
  Dashboard: await settledDashboard('en'),
  Activity: await settledActivity('en'),
  Recovery: await settledRecovery('en'),
  Sleep: await settledSleep('en'),
}
const dashboardNl = await settledDashboard('nl')
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
const HAS_ABSENCE_CHART: Record<string, boolean> = {
  Dashboard: true, Activity: true, Recovery: false, Sleep: false,
}

// Everything inside the accessible tables, which is where a chart's own numbers and absence words
// live. Asserting against the whole page cannot tell a chart's table apart from a card's basis
// line, which is how "translates absence words" passed while every chart table stayed English.
function tables(html: string): string {
  return [...html.matchAll(/<table class="sr-only">[\s\S]*?<\/table>/g)].map((m) => m[0]).join('\n')
}

describe.each(Object.entries(pages))('%s', (_name, html) => {
  it('names every chart and points it at a description', () => {
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
  it.skipIf(!HAS_ABSENCE_CHART[_name])('states absence in the accessible table, not silently', () => {
    expect(tables(html)).toMatch(/not worn|no reading/)
  })

  // These four pages carry most of the catalogue, so a mistyped key would otherwise render as
  // literal text like "dashboard.foo.bar" and every assertion above would still pass: none of
  // them look for the shape a missing translation actually takes.
  it('renders no raw message key', () => {
    expect(html).not.toMatch(/\b(dashboard|sleep|common|charts|activity|recovery|controlRow|emptyState|errorState)\.[a-zA-Z][a-zA-Z.]*\b/)
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
    // The stubbed week is seven days and only three of them report.
    expect(html).toContain('3 of 7 days')
    expect(html).not.toMatch(/(\d+) of \1 days/)
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

  it('does not label two different cards with the same name', () => {
    const labels = [...html.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('states the window every delta compared', () => {
    const deltas = [...html.matchAll(/class="delta"/g)].length
    const windows = [...html.matchAll(/change is the mean of the last (\d+) readings against the first (\d+)/g)]
    expect(deltas).toBeGreaterThan(0)
    expect(windows).toHaveLength(deltas)
    // A window comparing nothing against nothing is not a window. The old assertion counted these
    // on a page where every one of them read "the last 0 readings against the first 0".
    for (const window of windows) {
      expect(Number(window[1])).toBeGreaterThan(0)
      expect(Number(window[2])).toBeGreaterThan(0)
    }
  })
})
