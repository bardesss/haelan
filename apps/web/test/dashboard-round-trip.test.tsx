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

// happy-dom applies no stylesheet, so document.documentElement carries none of app.css's chart
// custom properties. Every other happy-dom test in this suite sidesteps that by never mounting a
// chart host for real; this one does, because the round trip has to run through an actual
// Sparkline to be the round trip. Without this, echarts.init's effect throws "missing chart
// token" the moment the steps card (the one card the stub gives real points for) draws.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Each test drives its own history. Without this a test inherits whatever the previous one
  // navigated to, which is the kind of order dependence that only shows up when a file is run
  // on its own months later.
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

/** Mounts a tree and flushes effects. Every render in these tests goes through act. */
function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

/**
 * A client that does not retry and never treats cached data as stale, following
 * page-controls.test.tsx's pattern: the session is seeded directly rather than fetched, so the
 * page mounts without a real /api/auth/me round trip.
 */
function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

/** Answers the session and the series, so the page can mount without a server. */
function stubFetch(seen: string[]): () => void {
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
    if (url.includes('/series')) {
      return new Response(JSON.stringify({
        steps: { points: [{ localDate: '2026-08-01', value: 900, coverage: 0.9, sourceMix: null }], reduction: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Dashboard round trip', () => {
  // The whole behaviour, across both units: the control row pushes a parameter, the URL changes,
  // the hook re-parses it, the query key changes, and a new request goes out for the new range.
  // Tasks 5 and 8 can each be green while this is broken.
  it('refetches for the new range when the control row changes the tab', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')

    mount(withQuery(<Dashboard />))
    await act(async () => { await Promise.resolve() })

    const before = seen.filter((u) => u.includes('/series')).length
    const week = [...container!.querySelectorAll('.segment')][1] as HTMLButtonElement
    act(() => { week.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })

    expect(window.location.search).toContain('range=week')
    const after = seen.filter((u) => u.includes('/series'))
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)).toContain('from=2026-08-10')
    restore()
  })

  // Not "one request for every card metric": /series takes exactly one agg for the whole call,
  // and the four cards need three different ones (steps and sleep_asleep_minutes share sum,
  // resting_heart_rate needs last, heart_rate needs mean), so one shared request would ask at
  // least two of them for an agg their own catalogue entry refuses and 500 the lot. What batching
  // by agg actually buys is fewer requests than cards: metrics that share an agg ride together,
  // so this is three requests for four cards, not four, and one of the three carries more than
  // one metric.
  it('batches by shared agg rather than firing one request per card', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')

    mount(withQuery(<Dashboard />))
    await act(async () => { await Promise.resolve() })

    const seriesCalls = seen.filter((u) => u.includes('/series'))
    expect(seriesCalls.length).toBeLessThan(4)
    expect(seriesCalls).toHaveLength(3)
    expect(seriesCalls.some((u) => u.match(/metric=/g)!.length > 1)).toBe(true)
    restore()
  })

  it('does not import the fixtures', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile('apps/web/src/pages/Dashboard.tsx', 'utf8'))
    expect(source).not.toContain('fixtures/july')
  })
})
