import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Dashboard } from '../src/pages/Dashboard.js'
import { Sleep } from '../src/pages/Sleep.js'
import { I18nProvider } from '../src/i18n/index.js'

// Dashboard now reads usePageControls and useSeries, both of which call useSession underneath,
// so it needs a QueryClient in the tree the way Sleep (still fixture backed) does not. A fresh,
// empty client rather than a seeded one: renderToStaticMarkup never waits on a promise, so
// leaving the session query unresolved and the series query disabled is what a server render of
// this page actually sees, not an approximation of it.
const withQuery = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
)

// The chart hosts render on the server; ECharts only touches them in an effect,
// so this exercises every prop, every basis string and every table alternative
// without a browser. Pinned to English: both pages now read their copy from the
// catalogue, and an unpinned instance falls back to navigator.language, which on a
// Dutch machine would render Dutch and break every literal-text assertion below.
const pages = {
  Dashboard: renderToStaticMarkup(<I18nProvider lng="en">{withQuery(<Dashboard />)}</I18nProvider>),
  Sleep: renderToStaticMarkup(<I18nProvider lng="en"><Sleep /></I18nProvider>),
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
    const tables = [...html.matchAll(/<table class="sr-only">/g)].length
    expect(tables).toBe(charts)
  })

  it('never renders a null, undefined or NaN into the page', () => {
    expect(html).not.toMatch(/>(null|undefined|NaN)</)
    expect(html).not.toContain('NaN')
  })

  it('never renders absence as a zero', () => {
    // Unworn days appear in the table alternatives as words, never as 0.
    expect(html).toMatch(/not worn|no reading/)
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
  const dashboardNl = renderToStaticMarkup(<I18nProvider lng="nl">{withQuery(<Dashboard />)}</I18nProvider>)
  const sleepNl = renderToStaticMarkup(<I18nProvider lng="nl"><Sleep /></I18nProvider>)

  it('translates column headers, weekday labels and absence words', () => {
    expect(dashboardNl).toContain('Datum')
    expect(dashboardNl).toContain('Weekdag')
    expect(dashboardNl).toContain('niet gedragen')
    expect(dashboardNl).not.toContain('>Date<')
    expect(dashboardNl).not.toContain('>Weekday<')
    expect(dashboardNl).not.toContain('not worn')
  })

  it('translates sleep stage names through the shared sleep.stage keys, not a second set', () => {
    expect(sleepNl).toContain('Diep')
    expect(sleepNl).not.toContain('>Deep<')
  })
})

describe('Dashboard specifics', () => {
  const html = pages.Dashboard

  it('states the heatmap colour domain rather than hiding a hardcoded maximum', () => {
    // Dashboard now reads steps from useSeries rather than the july fixture, and this render
    // never lets that query resolve (see the withQuery comment above: an empty client, no wait),
    // so the domain a reader sees before any request settles is 0 to 0. That is still a computed
    // domain, not the fixture's old maximum surviving by coincidence, which is what this pins.
    expect(html).toContain('0 to 0 steps')
    expect(html).toContain('stronger colour is more steps')
    // Pinned separately from the total in dashboard-cards.test.tsx's settled render: the heatmap
    // grid is dense (one cell per calendar day) from the moment the page mounts, so without its
    // own pending guard this would read "0 of 31 days worn" here, a specific false claim, rather
    // than the same vacuous "0 of 0" every sparse stat tile already shows before anything loads.
    expect(html).toContain('0 of 0 days worn')
  })

  it('does not label two different cards with the same name', () => {
    const labels = [...html.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('states the window every delta compared', () => {
    const deltas = [...html.matchAll(/class="delta"/g)].length
    const windows = [...html.matchAll(/change is the mean of the last \d+ readings against the first \d+/g)].length
    expect(windows).toBe(deltas)
  })
})
