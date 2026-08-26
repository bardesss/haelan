// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Dashboard } from '../src/pages/Dashboard.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { coverageFor } from './metricCoverage.js'

// Same reason dashboard-round-trip.test.tsx needs this: HeartRateRange and the other restored
// charts draw for real here, and echarts.init's effect throws "missing chart token" without it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

type Baseline = { center: number, spread: number, n: number, thin: boolean } | null

/**
 * Answers every route the Dashboard now calls: the session (seeded above, but a real render still
 * asks it once), /series for every requested metric, /sleep/nights, and /baselines with whichever
 * baseline the test wants. One canned point per metric, the same way
 * dashboard-round-trip.test.tsx's stubFetchOnePointPerMetric does, so heart_rate has something to
 * plot and the band, when the baseline says to draw one, has an axis to sit on.
 */
function stubFetch(opts: { baseline: Baseline }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: [{ localDate: '2026-08-15', value: 60, coverage: coverageFor(metric), sourceMix: null }],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: opts.baseline }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the remaining Dashboard cards', () => {
  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no baseline band when the baseline is thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 3, thin: true } })
    mount(withQuery(<Dashboard />))
    await flush(() => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws the band when the baseline is not thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 28, thin: false } })
    mount(withQuery(<Dashboard />))
    await flush(() => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // Not a placeholder and not a lie. No route serves typed events yet.
  it('shows flagged days as empty rather than wiring it to something event shaped', async () => {
    const restore = stubFetch({ baseline: null })
    mount(withQuery(<Dashboard />))
    await flush(() => container!.innerHTML)
    // No I18nProvider in this tree, the same way dashboard-round-trip.test.tsx mounts it: without
    // one react-i18next has no catalogue to resolve against and renders the key itself, which is
    // what this asserts on rather than the English prose.
    expect(container!.textContent).toContain('dashboard.flaggedDays.emptyTitle')
    restore()
  })

  // stubFetch answers every requested metric with exactly one point (2026-08-15), so a real
  // month range has far more calendar days than reporting days. The basis must count the former;
  // basisOf(stepsPoints) would have read the same "1 of 1" it would for a single-day range, which
  // is the regression pages.test.tsx once pinned in as correct.
  it('states the heatmap total against every calendar day in range, not just the days that reported', async () => {
    const restore = stubFetch({ baseline: null })
    // Real interpolation needed here, unlike the other tests in this file: without an
    // I18nProvider, t() returns the raw key and the numbers this test reads never appear as text.
    mount(<I18nProvider lng="en">{withQuery(<Dashboard />)}</I18nProvider>)
    await flush(() => container!.innerHTML)
    const match = container!.textContent!.match(/(\d+) of (\d+) days worn/)
    expect(match).not.toBeNull()
    expect(Number(match![2])).toBeGreaterThan(1)
    restore()
  })

  // The defect the stub above was hiding. Every sleep row the server can send carries
  // coverage: null, and reading that as a zero made the card render "Device not worn" over a
  // month of real nights while the mean was never drawn at all.
  it('draws the sleep mean over rows whose coverage is null rather than calling the device unworn', async () => {
    const restore = stubFetch({ baseline: null })
    mount(<I18nProvider lng="en">{withQuery(<Dashboard />)}</I18nProvider>)
    await flush(() => container!.innerHTML)
    // 60 minutes is what the stub answers for every metric, so this string belongs to the one
    // card that formats its value as a duration.
    expect(container!.textContent).toContain('1h 00m')
    expect(container!.textContent).not.toContain('Device not worn')
    restore()
  })

  it('does not import the fixtures', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('apps/web/src/pages/Dashboard.tsx', 'utf8')
    expect(source).not.toContain('fixtures/july')
  })
})
