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
import { flush } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// The steps card draws a real Sparkline once it has a point, and echarts.init throws
// without the chart tokens happy-dom never applies: same setup dashboard-round-trip uses.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/dashboard?range=month&on=2026-09-15')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

// A phone-only history starting 2026-09-13T10:00:00Z, mid month in Amsterdam, answering
// every requested metric with one point on that date so no card stays empty for lack
// of rows.
function stubFetch(seen: string[], googleConnected: boolean): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify({
        personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true,
        timezone: 'Europe/Amsterdam',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/companion/cursors')) {
      return new Response(JSON.stringify({
        items: [], historyStartMs: Date.parse('2026-09-13T10:00:00Z'), googleConnected,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: [seriesPoint(metric, '2026-09-13', 100)], reduction: null }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('a phone-only history start', () => {
  // T5.3 acceptance: an all time card on a phone-only instance must not show a 30 day
  // window. The month tab opens 2026-09-01, the phone measures since 2026-09-13, so
  // every series request the cards send has to carry from=2026-09-13 once the start
  // has loaded, and the "1 of 30 days" denominator goes away with it.
  it('moves every card series request onto the history start', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen, false)
    const { client, tree } = withQuery(<Dashboard />)
    act(() => { root?.render(tree) })
    await flush(client, () => container!.innerHTML)

    const series = seen.filter((u) => u.includes('/series'))
    expect(series.length).toBeGreaterThan(0)
    // The first wave fires before the history answer lands, so it still carries the
    // tab start. What matters is convergence: once a clamped request goes out, no
    // unclamped one follows it.
    const firstClamped = series.findIndex((u) => u.includes('from=2026-09-13'))
    expect(firstClamped).toBeGreaterThanOrEqual(0)
    expect(series.slice(firstClamped).every((u) => u.includes('from=2026-09-13'))).toBe(true)
    restore()
  })

  // T5.3 passo 4: a person who also walks the Google path keeps the deep archive,
  // so the same month tab keeps asking from the tab start.
  it('leaves the tab window alone when Google is also connected', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen, true)
    const { client, tree } = withQuery(<Dashboard />)
    act(() => { root?.render(tree) })
    await flush(client, () => container!.innerHTML)

    const series = seen.filter((u) => u.includes('/series'))
    expect(series.length).toBeGreaterThan(0)
    expect(series.every((u) => u.includes('from=2026-09-01'))).toBe(true)
    restore()
  })
})
