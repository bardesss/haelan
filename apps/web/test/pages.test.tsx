// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Dashboard } from '../src/pages/Dashboard.js'
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

/** Mounts the Dashboard for real, waits for every query to settle, and returns the settled markup. */
async function settledDashboard(lng: string): Promise<string> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  window.history.replaceState(null, '', RANGE)
  const tree: ReactNode = (
    <I18nProvider lng={lng}><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></I18nProvider>
  )
  act(() => { root.render(tree) })
  await flush(() => container.innerHTML)
  const html = container.innerHTML
  act(() => { root.unmount() })
  container.remove()
  return html
}

const restore = stubFetch()
// Sleep is still fixture backed and resolves nothing, so a static render is the whole of it. Its
// ControlRow reads the session and the sync status, hence the client in the tree.
const sleepHtml = (lng: string) => renderToStaticMarkup(
  <I18nProvider lng={lng}>
    <QueryClientProvider client={new QueryClient()}><Sleep /></QueryClientProvider>
  </I18nProvider>,
)
const pages = {
  Dashboard: await settledDashboard('en'),
  Sleep: sleepHtml('en'),
}
const dashboardNl = await settledDashboard('nl')
const sleepNl = sleepHtml('nl')
restore()

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

  it('never renders absence as a zero', () => {
    // Both halves of the rule, against a page that has really answered. A day with no row shows a
    // word in the table alternatives, and no headline value is the zero a formatter produces when
    // it is handed nothing.
    expect(tables(html)).toMatch(/not worn|no reading/)
    expect(html).not.toMatch(/<div class="value">0(<|&nbsp;| )/)
  })

  // These two pages carry most of the catalogue, so a mistyped key would otherwise render as
  // literal text like "dashboard.foo.bar" and every assertion above would still pass: none of
  // them look for the shape a missing translation actually takes.
  it('renders no raw message key', () => {
    expect(html).not.toMatch(/\b(dashboard|sleep|common|charts)\.[a-zA-Z][a-zA-Z.]*\b/)
  })
})

describe('chart tables follow the active language', () => {
  // Every chart's accessible table used to be built from English literals regardless of the
  // active language, which meant a Dutch screen reader user got an English table on both pages.
  it('translates column headers, weekday labels and absence words', () => {
    const nlTables = tables(dashboardNl)
    expect(nlTables).toContain('Datum')
    expect(nlTables).toContain('Weekdag')
    // In a chart table, not merely somewhere on the page: this used to be satisfied by a tile's
    // own basis line while every table below it stayed English.
    expect(nlTables).toContain('niet gedragen')
    expect(nlTables).toContain('geen meting')
    expect(nlTables).not.toContain('>Date<')
    expect(nlTables).not.toContain('>Weekday<')
    expect(nlTables).not.toContain('not worn')
    expect(nlTables).not.toContain('no reading')
  })

  it('translates sleep stage names through the shared sleep.stage keys, not a second set', () => {
    expect(sleepNl).toContain('Diep')
    expect(sleepNl).not.toContain('>Deep<')
  })
})

describe('Dashboard specifics', () => {
  const html = pages.Dashboard

  it('states the heatmap colour domain from the steps it actually drew', () => {
    // The stub's largest step count. Read off the data rather than pinned to a fixture maximum,
    // and no longer the "0 to 0" a page that had asked nothing used to print.
    expect(html).toContain('0 to 81 steps')
    expect(html).toContain('stronger colour is more steps')
  })

  it('counts the basis against every calendar day in the period, not the days that answered', () => {
    // The stubbed week is seven days and only three of them report.
    expect(html).toContain('3 of 7 days')
    expect(html).not.toMatch(/(\d+) of \1 days/)
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
