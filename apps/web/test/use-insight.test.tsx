// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useInsight, insightPath } from '../src/data/useInsight.js'
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

describe('insightPath', () => {
  it('carries the four values, and omits source for the all-sources sentinel', () => {
    const url = new URL(insightPath('p1', 'steps', 'sum', '2026-08-10', '2026-08-16', ALL_SOURCES), 'http://x')
    expect(url.pathname).toBe('/api/v1/p/p1/insights')
    expect(Object.fromEntries(url.searchParams))
      .toEqual({ metric: 'steps', agg: 'sum', from: '2026-08-10', to: '2026-08-16' })
  })

  it('sends source when one is chosen', () => {
    const url = new URL(insightPath('p1', 'steps', 'sum', '2026-08-10', '2026-08-16', 'dev1'), 'http://x')
    expect(url.searchParams.get('source')).toBe('dev1')
  })
})

describe('useInsight', () => {
  it('does not fetch until the session has resolved a person', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch

    function Probe() {
      useInsight('steps', 'sum', { from: '2026-08-10', to: '2026-08-16' }, ALL_SOURCES)
      return null
    }
    mount(withoutSession(<Probe />))
    // Same reasoning as useSeries's own gating test in data-hooks.test.tsx: the session query's
    // fetch resolves asynchronously, so only a real trip through microtasks can tell a disabled
    // insight query (whose queryFn never runs at all) apart from one that ran and is still pending.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    // The session query itself fires exactly once. What must not fire is an insight request for
    // an undefined person, which would be a request for /api/v1/p/undefined/insights.
    expect(calls).toBe(1)
  })
})
