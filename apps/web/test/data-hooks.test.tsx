// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSeries, seriesPath } from '../src/data/useSeries.js'
import { baselinePath } from '../src/data/useBaseline.js'
import { nightsPath } from '../src/data/useNights.js'
import { ALL_SOURCES } from '../src/controls/source.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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

/**
 * A client with no session cached, the exact state on first paint before /api/auth/me answers.
 * Kept separate from a "with session" helper rather than folding the session into an optional
 * parameter: an optional parameter defaults when a caller passes `undefined` explicitly, which
 * would make a test that means to withhold the session quietly get it anyway.
 */
function withoutSession(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

describe('seriesPath', () => {
  // One request for four cards. /series takes a repeated metric parameter, which M3b-2 added
  // precisely so a dashboard does not open four connections to draw four sparklines.
  // Real catalogue ids. 'sleep_minutes' is not a metric packages/core/src/derive/metrics.ts
  // defines, and while a path builder does not care, it is exactly the string a future reader
  // copies into a request that then 400s.
  it('repeats the metric parameter rather than making one call per metric', () => {
    const path = seriesPath('p1', ['steps', 'sleep_asleep_minutes'], { from: '2026-08-01', to: '2026-08-31', source: 'merged' }, 'sum')
    expect(path).toContain('metric=steps')
    expect(path).toContain('metric=sleep_asleep_minutes')
    expect(path.match(/metric=/g)).toHaveLength(2)
  })

  it('binds the path to the person from the session, never from the URL', () => {
    expect(seriesPath('p1', ['steps'], { from: '2026-08-01', to: '2026-08-01', source: 'merged' }, 'sum'))
      .toContain('/api/v1/p/p1/series')
  })

  // merged is a real source value the derivation writes, not a sentinel the client invents.
  // Sending it explicitly is what asks for the merged rows specifically, as distinct from the all
  // sources sentinel below, which omits the parameter instead.
  it('carries the source through', () => {
    expect(seriesPath('p1', ['steps'], { from: '2026-08-01', to: '2026-08-01', source: 'watch' }, 'sum'))
      .toContain('source=watch')
  })

  // The option name promises every source. merged is one particular source, the one this app
  // computed, and two metrics in this database have none at all: sending source=merged for those
  // asked for rows that were never written. Omitting the parameter is what actually means "all
  // sources", letting the query layer's own preferMerged take the merged row where there is one.
  it('builds a series path with no source parameter for the all sentinel', () => {
    const path = seriesPath('p1', ['floors'], { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES }, 'sum')
    expect(path).not.toContain('source=')
  })
})

describe('baselinePath', () => {
  // Same distinction as seriesPath's two source tests: a real device name is sent as-is, and the
  // one thing this task exists to fix is that the all sources sentinel omits the parameter rather
  // than sending a name (merged) that two metrics in this schema have no rows under.
  it('carries the source through', () => {
    expect(baselinePath('p1', 'heart_rate', '2026-08-31', 'watch', 'mean')).toContain('source=watch')
  })

  it('builds a baseline path with no source parameter for the all sentinel', () => {
    const path = baselinePath('p1', 'heart_rate', '2026-08-31', ALL_SOURCES, 'mean')
    expect(path).not.toContain('source=')
  })
})

describe('nightsPath', () => {
  // Tier 2's requireSource refuses a source it does not recognise (no daily-rollup-only values
  // like merged are registered there), so a real device name still has to reach the request
  // unchanged for a device filtered sleep page to work at all.
  it('carries the source through', () => {
    const path = nightsPath('p1', { from: '2026-08-01', to: '2026-08-31', source: 'watch' })
    expect(path).toContain('source=watch')
  })

  it('builds a nights path with no source parameter for the all sentinel', () => {
    const path = nightsPath('p1', { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES })
    expect(path).not.toContain('source=')
  })
})

describe('useSeries', () => {
  it('does not fetch until the session has resolved a person', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch

    function Probe() {
      useSeries(['steps'], { from: '2026-08-01', to: '2026-08-31', source: 'merged' })
      return null
    }
    mount(withoutSession(<Probe />))
    // The session query's own fetch resolves asynchronously (a real fetch, not a synchronous
    // return), so a synchronous check right after mount would pass even with the enabled guard
    // removed: a disabled series query's queryFn simply never runs, synchronously or not, and the
    // only way to see that has to include the trip through microtasks a real fetch takes.
    await new Promise((resolve) => setTimeout(resolve, 20))

    globalThis.fetch = originalFetch
    // The session query itself fires exactly once (no data cached to short circuit it). What must
    // not fire is a series request for an undefined person, which would be a request for
    // /api/v1/p/undefined/series.
    expect(calls).toBe(1)
  })
})
