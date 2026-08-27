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
import { seriesPoint } from './metricCoverage.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason dashboard-round-trip.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/dashboard?range=week&on=2026-08-12')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12']

function stubFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null })
    if (url.includes('/series')) {
      const body: Record<string, unknown> = {}
      for (const metric of new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')) {
        body[metric] = {
          points: DAYS.map((date, i) => seriesPoint(metric, date, 400 + i * 10)),
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/sleep/nights')) {
      const start = Date.parse('2026-08-11T22:00:00Z')
      return json({
        items: [{
          localDate: '2026-08-12', sourceId: 'watch', sessionIds: ['s1'],
          startMs: start, endMs: start + 6 * 3_600_000,
          startOffsetMinutes: 120, endOffsetMinutes: 120,
          segments: [{ stage: 'DEEP', startMs: start, endMs: start + 6 * 3_600_000 }],
        }],
        cursor: null,
      })
    }
    return json({ baseline: { center: 60, spread: 4, n: 40, thin: false } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Whatever echarts.init rendered into each chart host. dispose() empties the host and a fresh
 * init fills it again, so a chart that survived a render keeps the very same node and one that
 * was torn down and rebuilt does not.
 */
function chartRoots(): (Element | null)[] {
  return [...container!.querySelectorAll('[role="img"]')].map((host) => host.firstElementChild)
}

describe('the charts across a rerender', () => {
  // Section 7 of the spec names "a chart disposed on every render" as one of the two defect
  // classes the render environment was added to catch, and it came back one task later: useChart
  // keys its effect on `build`, every chart's `build` is a useCallback over its data props, and
  // the page handed all five of them freshly constructed arrays on every commit. With eight
  // queries settling at different moments that is roughly eight teardowns and rebuilds of five
  // echarts instances on a single page load.
  it('are not disposed and re-initialised when nothing they draw has changed', async () => {
    const restore = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<Dashboard />)) })
    await flush(client, () => container!.innerHTML)

    const before = chartRoots()
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((node) => node !== null)).toBe(true)

    // A second render of the same component with the same client: every query is already settled
    // and staleTime is Infinity, so nothing the charts draw has changed.
    act(() => { root!.render(tree(<Dashboard />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const after = chartRoots()
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i], `chart ${i} was re-initialised`).toBe(before[i])
    }
    restore()
  })
})
