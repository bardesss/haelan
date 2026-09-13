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
import { useWorkoutSession, sessionPath } from '../src/data/useWorkoutSession.js'
import { useIntradayWindow, intradayWindowPath } from '../src/data/useIntradayWindow.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'

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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * A client with the session already resolved and cached, the state a page reaches once
 * /api/auth/me has answered. Seeded with setQueryData rather than mocked through fetch: the
 * session query itself is not what these tests are about, and seeding it means the fetch mock
 * below counts and names only the requests the hook under test makes, not a same-tick session
 * request racing it too.
 */
function withSession(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
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
    //
    // Inside act, because the thing being waited for is a render: the session settling notifies
    // react-query, which re-renders Probe through useSyncExternalStore. Outside act that render is
    // not flushed before the assertion below, so a series request enabled by the freshly arrived
    // person could still be queued when calls is read, and the test would pass by reading too early
    // rather than because the guard held. act also makes React warn if a future edit reintroduces
    // an unflushed update here.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    // The session query itself fires exactly once (no data cached to short circuit it). What must
    // not fire is a series request for an undefined person, which would be a request for
    // /api/v1/p/undefined/series.
    expect(calls).toBe(1)
  })
})

// useWorkoutSession and useIntradayWindow both compound two conditions into one `enabled`
// (personId resolved, and a second local fact - sessionId present, or options.enabled). A
// path-builder test never touches `enabled` at all, so it cannot tell a working guard from one
// where the && became || or half the condition was dropped: either still compiles, and a request
// for an undefined id still succeeds if the id happens to route somewhere (or 404s quietly if it
// does not), leaving the bug to surface only as an extra network call nothing here would have
// caught. These mount-and-count blocks exist to close exactly that gap, the same way the
// useSeries block above does for its own guard.
describe('useWorkoutSession', () => {
  it('does not fetch when the session has not resolved a person', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch

    function Probe() {
      useWorkoutSession('run1')
      return null
    }
    mount(withoutSession(<Probe />))
    // Same reasoning as the useSeries test above: the session fetch is real and resolves
    // asynchronously, so only a wait that survives a real microtask trip can tell a query that
    // never ran apart from one that simply has not run yet.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    // Only the session query itself should fire. What must not fire is a session-by-id request for
    // an unresolved person, which would be a request for /api/v1/p/undefined/sessions/run1.
    expect(calls).toBe(1)
  })

  it('does not fetch when sessionId is undefined, even with a resolved person', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch

    function Probe() {
      useWorkoutSession(undefined)
      return null
    }
    // withSession seeds the person synchronously, so no /api/auth/me request happens either:
    // nothing at all should reach the fetch mock while sessionId stays undefined.
    mount(withSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    expect(calls).toBe(0)
  })

  it('fetches exactly once, to the expected path, once both are present', async () => {
    let calls = 0
    let lastUrl: string | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1
      lastUrl = String(input)
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useWorkoutSession('run1')
      return null
    }
    mount(withSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    expect(calls).toBe(1)
    expect(lastUrl).toBe(sessionPath('p1', 'run1'))
  })

  // A collision here is not abstract cache hygiene: it renders one workout's data on another
  // workout's detail page - in a health app, Tuesday's heart rate read and believed under
  // Thursday's date. queryKeys.resource(personId, 'session', { sessionId }) is what keeps the two
  // apart; if that ever lost its sessionId member, both mounts below would share one cache entry,
  // the second would never fetch, and it would render the first's session instead of its own.
  it('keeps two sessionIds from colliding on one cache entry', async () => {
    let calls = 0
    const urls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1
      const url = String(input)
      urls.push(url)
      // Each response names which session it answers, so the DOM assertions below can tell
      // whether a hook actually resolved its own request rather than silently reading the other
      // session's cache entry.
      const id = url.endsWith('/run1') ? 'run1' : url.endsWith('/run2') ? 'run2' : 'unexpected'
      return new Response(JSON.stringify({ id }), { status: 200 })
    }) as typeof fetch

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)

    function ProbeA() {
      const result = useWorkoutSession('run1')
      return <span className="a">{result.data?.id ?? ''}</span>
    }
    function ProbeB() {
      const result = useWorkoutSession('run2')
      return <span className="b">{result.data?.id ?? ''}</span>
    }
    mount(<QueryClientProvider client={client}><ProbeA /><ProbeB /></QueryClientProvider>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    // Two different sessions, two distinct requests. A collapsed cache key would leave this at 1:
    // the second mount reading the first's already-cached entry instead of fetching its own.
    expect(calls).toBe(2)
    expect(new Set(urls)).toEqual(new Set([sessionPath('p1', 'run1'), sessionPath('p1', 'run2')]))

    // Not just two requests: each hook resolves its own session, not the other's.
    expect(container!.querySelector('.a')!.textContent).toBe('run1')
    expect(container!.querySelector('.b')!.textContent).toBe('run2')
  })
})

describe('useIntradayWindow', () => {
  const QUERY = {
    metric: 'heart_rate', startMs: Date.UTC(2026, 7, 18, 22, 0), endMs: Date.UTC(2026, 7, 18, 23, 0),
    source: ALL_SOURCES,
  }

  it('does not fetch when the session has not resolved a person', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{"points":[],"reduction":null}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useIntradayWindow(QUERY)
      return null
    }
    mount(withoutSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    // Only the session query itself should fire. What must not fire is an intraday window request
    // for an unresolved person, which would be a request for /api/v1/p/undefined/intraday/window.
    expect(calls).toBe(1)
  })

  it('does not fetch when explicitly disabled, even with a resolved person', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{"points":[],"reduction":null}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useIntradayWindow(QUERY, { enabled: false })
      return null
    }
    mount(withSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    expect(calls).toBe(0)
  })

  it('fetches exactly once, to the expected path, once both are present and enabled', async () => {
    let calls = 0
    let lastUrl: string | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1
      lastUrl = String(input)
      return new Response('{"points":[],"reduction":null}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useIntradayWindow(QUERY)
      return null
    }
    mount(withSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    expect(calls).toBe(1)
    expect(lastUrl).toBe(intradayWindowPath('p1', QUERY))
  })
})
