// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { usePageControls } from '../src/controls/usePageControls.js'
import type { PageControlsState } from '../src/controls/usePageControls.js'

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
  // A safety net rather than the primary reset: the clock test restores real timers itself, but
  // an assertion failure there would otherwise leak a mocked clock into whatever test runs next.
  vi.useRealTimers()
})

/** Mounts a tree and flushes effects. Every render in these tests goes through act. */
function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * A client that does not retry, so a failed query surfaces in the test rather than after it.
 * Seeds the session directly, following shell-session.test.tsx's pattern, rather than letting
 * useSession fetch: an unmocked fetch to /api/auth/me is not merely slow here, something on this
 * machine actually answers on :3000, so a unit test would be making a real network call. Infinite
 * staleTime matters here in a way it does not in shell-session.test.tsx: that file renders once
 * with renderToStaticMarkup, which never runs effects, but these tests mount for real, so without
 * it TanStack Query's refetch-on-mount would fire the same live fetch straight back in.
 */
function withQuery(node: ReactNode, session: Session = PERSON): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), session)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

let seen: PageControlsState | null = null

function Probe() {
  seen = usePageControls()
  return null
}

function mountProbe(session?: Session): void {
  mount(withQuery(<Probe />, session))
}

describe('usePageControls', () => {
  it('reads the range and anchor out of the URL and resolves them to a period', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    expect(seen!.tab).toBe('month')
    expect(seen!.from).toBe('2026-08-01')
    expect(seen!.to).toBe('2026-08-31')
  })

  // The whole point of putting state in the URL: a change goes to the URL, and the hook reads it
  // back. If this passes while the hook keeps its own copy, the copy is what is being tested.
  it('writes a tab change to the URL and reads the new period back', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    act(() => { seen!.setTab('week') })
    expect(window.location.search).toContain('range=week')
    expect(seen!.from).toBe('2026-08-10')
    expect(seen!.to).toBe('2026-08-16')
  })

  it('steps the anchor by one whole period', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    act(() => { seen!.step(1) })
    expect(seen!.anchor).toBe('2026-09-15')
    expect(seen!.from).toBe('2026-09-01')
  })

  // A tab change is somewhere to go back from. Thirty stepper clicks are not.
  it('pushes a tab change and replaces a step', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    const afterMount = window.history.length
    act(() => { seen!.setTab('day') })
    expect(window.history.length).toBe(afterMount + 1)
    const afterTab = window.history.length
    act(() => { seen!.step(1) })
    act(() => { seen!.step(1) })
    expect(window.history.length).toBe(afterTab)
  })

  it('keeps the other parameters when one changes', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15&source=watch')
    mountProbe()
    act(() => { seen!.setTab('year') })
    expect(window.location.search).toContain('source=watch')
    expect(window.location.search).toContain('on=2026-08-15')
  })

  it('carries the source through and lets it change', () => {
    window.history.replaceState(null, '', '/dashboard?source=watch')
    mountProbe()
    expect(seen!.source).toBe('watch')
    act(() => { seen!.setSource('merged') })
    expect(seen!.source).toBe('merged')
  })

  // Task 3 carried people.timezone all the way to the browser for exactly this default. Every
  // other test in this file pins an explicit on=, so none of them would notice if the hook read
  // the machine's zone instead of the session's. No single fixture zone catches that fallback on
  // every machine this suite might run on: at a given instant, every negative offset (Honolulu
  // included) and UTC itself agree with each other, so a fixture picked to disagree with one
  // machine can still agree with another, including the UTC runners CI actually uses. What holds
  // regardless of where the test runs is that changing the person's timezone changes the answer,
  // so this pins one instant and mounts twice, once per fixture fourteen hours apart, and checks
  // both the specific dates and that they differ. The fallback reads the same machine zone both
  // times, so it would make the two mounts agree everywhere, not just on some machines.
  it("resolves an absent 'on' to the person's today, not the machine's", () => {
    vi.setSystemTime(new Date('2026-08-15T23:30:00Z'))
    window.history.replaceState(null, '', '/dashboard')

    mountProbe({ ...PERSON, timezone: 'Pacific/Kiritimati' })
    const kiritimati = seen!.anchor

    // A fresh root for the second fixture, not a re-render into the first one: swapping the
    // QueryClientProvider's client mid-tree does not flush TanStack Query's observer
    // synchronously, so the second mount read the first client's cached data rather than its own.
    act(() => { root?.unmount() })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    mountProbe({ ...PERSON, timezone: 'Pacific/Honolulu' })
    const honolulu = seen!.anchor

    expect(kiritimati).toBe('2026-08-16')
    expect(honolulu).toBe('2026-08-15')
    expect(kiritimati).not.toBe(honolulu)

    vi.useRealTimers()
  })

  // M3 phase review B2: a Month or Year view's `to` is the period's calendar end, which is in the
  // future for all but the last day of the period. A baseline or an insight window anchored on it
  // read the tomorrows of a period still in progress as though they had already happened.
  describe('historicalTo', () => {
    it('is today, not the calendar end, when the range reaches into the future', () => {
      vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
      // No 'on': the default anchor is the person's today, so the default month tab resolves to
      // the whole of September while only the 5th has actually happened.
      window.history.replaceState(null, '', '/dashboard?range=month')
      mountProbe()
      expect(seen!.to).toBe('2026-09-30')
      expect(seen!.historicalTo).toBe('2026-09-05')
      vi.useRealTimers()
    })

    it('is the range\'s own end when the whole range has already happened', () => {
      vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
      window.history.replaceState(null, '', '/dashboard?range=month&on=2026-07-15')
      mountProbe()
      expect(seen!.to).toBe('2026-07-31')
      expect(seen!.historicalTo).toBe('2026-07-31')
      vi.useRealTimers()
    })

    it('is today itself on the one day of the month it agrees with the calendar end', () => {
      vi.setSystemTime(new Date('2026-09-30T10:00:00Z'))
      window.history.replaceState(null, '', '/dashboard?range=month')
      mountProbe()
      expect(seen!.to).toBe('2026-09-30')
      expect(seen!.historicalTo).toBe('2026-09-30')
      vi.useRealTimers()
    })

    // Round 2 of the same defect: capping at today alone is not enough. A period that has not
    // started yet has `from` itself after today, and a `to` capped at today with no floor would
    // fall behind `from`, inverting the range useInsight sends. requireRange in
    // packages/core/src/query/personQuery.ts refuses any from-after-to request with a 400, so this
    // is not only a display glitch: it is a real 400 reachable in one stepper click.
    it('is the range\'s own start, not today, when the whole range has not started yet', () => {
      vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
      window.history.replaceState(null, '', '/dashboard?range=month&on=2026-10-15')
      mountProbe()
      expect(seen!.from).toBe('2026-10-01')
      expect(seen!.to).toBe('2026-10-31')
      expect(seen!.historicalTo).toBe('2026-10-01')
      // The invariant this whole field exists to keep: whatever the period, historicalTo never
      // falls before `from`, or every caller that pairs it with `from` (useInsight) would be one
      // future period away from sending a range the server refuses.
      expect(seen!.from <= seen!.historicalTo).toBe(true)
      vi.useRealTimers()
    })
  })
})
