// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  useAnnotations, useWriteOverride, useWriteNote,
  notesPath, eventsPath, overridesPath,
} from '../src/data/useAnnotations.js'
import type { WriteOverrideInput, WriteNoteInput } from '../src/data/useAnnotations.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { useBaseline } from '../src/data/useBaseline.js'

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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
}

/**
 * A client with no session cached, the exact state on first paint before /api/auth/me answers.
 * Kept separate from a "with session" helper for the reason data-hooks.test.tsx's own copy of this
 * gives: an optional parameter defaults when a caller passes `undefined` explicitly, which would
 * make a test that means to withhold the session quietly get it anyway.
 */
function withoutSession(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

/** A client with the session already resolved, so a mutation's guard against an undefined person
 * never fires and the test is exercising the invalidation logic rather than that guard. */
function withSession(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const INPUT: WriteOverrideInput = {
  scope: 'day_metric', targetKey: '{"localDate":"2026-08-15","metric":"steps"}', action: 'exclude', reason: 'phone in a bag',
}

function WriteOverrideButton({ input }: { input: WriteOverrideInput }) {
  const mutation = useWriteOverride()
  return <button type="button" onClick={() => mutation.mutate(input)}>write override</button>
}

function WriteNoteButton({ input }: { input: WriteNoteInput }) {
  const mutation = useWriteNote()
  return <button type="button" onClick={() => mutation.mutate(input)}>write note</button>
}

/** Mounts the overrides list as a real active query, alongside the write button, so an
 * invalidation of that resource has an observer to actually refetch rather than only marking a
 * cache entry stale with nothing watching it. */
function OverridesListAndWriteButton({ input }: { input: WriteOverrideInput }) {
  useAnnotations({ from: '2026-08-01', to: '2026-08-31' })
  const mutation = useWriteOverride()
  return <button type="button" onClick={() => mutation.mutate(input)}>write override</button>
}

/** Mounts two real useBaseline queries, anchored so only one's own sixty day window overlaps
 * INPUT's target day (2026-08-15), alongside the write button: a real observer under useBaseline's
 * own queryKey is what actually exercises D9's fix, rather than a key this test hand assembles to
 * match whatever overlapsAffected already accepts. */
function TwoBaselinesAndWriteButton({ input }: { input: WriteOverrideInput }) {
  useBaseline('steps', '2026-08-31', ALL_SOURCES, 'sum')
  useBaseline('steps', '2026-01-31', ALL_SOURCES, 'sum')
  const mutation = useWriteOverride()
  return <button type="button" onClick={() => mutation.mutate(input)}>write override</button>
}

function click(): void {
  const button = container!.querySelector('button') as HTMLButtonElement
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

describe('path builders', () => {
  it('scopes notesPath to the range and the person', () => {
    expect(notesPath('p1', { from: '2026-08-01', to: '2026-08-31' }))
      .toBe('/api/v1/p/p1/notes?from=2026-08-01&to=2026-08-31')
  })

  it('scopes eventsPath to the range and the person', () => {
    expect(eventsPath('p1', { from: '2026-08-01', to: '2026-08-31' }))
      .toBe('/api/v1/p/p1/events?from=2026-08-01&to=2026-08-31')
  })

  // GET /overrides takes no range at all (apps/server/src/routes/v1/annotations.ts), because the
  // management list this feeds wants every correction for the person regardless of what range a
  // caller happens to be looking at. Sending one would ask a question the route already refuses.
  it('builds overridesPath with no range, since the route takes none', () => {
    expect(overridesPath('p1')).toBe('/api/v1/p/p1/overrides')
  })
})

describe('useAnnotations', () => {
  it('does not fetch notes, events or overrides until the session has resolved a person', async () => {
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return respond(200, {}) }) as typeof fetch

    function Probe() {
      useAnnotations({ from: '2026-08-01', to: '2026-08-31' })
      return null
    }
    mount(withoutSession(<Probe />))
    // The session query's own fetch resolves asynchronously, so a synchronous check right after
    // mount would pass even with every `enabled` guard removed: a disabled query's queryFn simply
    // never runs, and the only way to see that has to include the trip through microtasks a real
    // fetch takes, the same reasoning useSeries' own version of this test gives. Inside act for
    // that test's reason too: the session settling re-renders Probe, and an unflushed render means
    // the count below could be read before a request the arriving person enabled ever fired.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = original
    // Exactly one fetch, the session's own. Three more (notes, events, overrides) firing for an
    // undefined person would each be a request for /api/v1/p/undefined/....
    expect(calls).toBe(1)
  })

  // The route ignores range for overrides, and the point of that is a single list a management
  // page and a day panel can share. Mounting useAnnotations twice at two different ranges and
  // counting the actual /overrides fetches is what makes this a real test of that sharing: a
  // version that keyed the overrides read by range would still equal itself trivially but would
  // fetch the list twice here, once per range, instead of once.
  it('shares one overrides fetch across two different ranges, since the route answers the same list either way', async () => {
    function TwoRangesProbe() {
      useAnnotations({ from: '2026-08-01', to: '2026-08-31' })
      useAnnotations({ from: '2026-09-01', to: '2026-09-30' })
      return null
    }
    const { tree } = withSession(<TwoRangesProbe />)
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return respond(200, { items: [] })
    }) as typeof fetch

    mount(tree)
    await settle()
    globalThis.fetch = original

    expect(calls.filter((call) => call.includes('/overrides'))).toHaveLength(1)
    // Notes and events, by contrast, really do differ by range, so each range fetches its own.
    expect(calls.filter((call) => call.includes('/notes'))).toHaveLength(2)
    expect(calls.filter((call) => call.includes('/events'))).toHaveLength(2)
  })
})

describe('useWriteOverride, applied true', () => {
  it('invalidates a cached range that overlaps affected, and leaves a disjoint one alone', async () => {
    const { client, tree } = withSession(<WriteOverrideButton input={INPUT} />)
    const overlapping = queryKeys.resource('p1', 'series', {
      metrics: ['steps'], from: '2026-08-14', to: '2026-08-16', agg: 'sum',
    })
    const disjoint = queryKeys.resource('p1', 'series', {
      metrics: ['steps'], from: '2026-09-01', to: '2026-09-30', agg: 'sum',
    })
    client.setQueryData(overlapping, { steps: { points: [], reduction: null } })
    client.setQueryData(disjoint, { steps: { points: [], reduction: null } })

    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, {
      id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: true,
    })) as typeof fetch

    mount(tree)
    click()
    await settle()
    globalThis.fetch = original

    expect(client.getQueryState(overlapping)?.isInvalidated).toBe(true)
    expect(client.getQueryState(disjoint)?.isInvalidated).toBe(false)
  })

  // D9: useBaseline's own queryKey used to carry `on` alone, an anchor with no from/to for
  // overlapsAffected to compare against, so an exclusion never invalidated the baseline it fed;
  // the band and its note kept the excluded day's old centre until staleTime expired or the
  // component remounted. The fix gives the key the same window baselineWindow(on) actually reads
  // (packages/core/src/query/baseline.ts), sixty days ending the day before `on`, so this behaves
  // exactly like the 'series' case above once the key carries a real range.
  //
  // Two real useBaseline queries, not two hand assembled keys: this is what actually exercises
  // whatever key the hook itself builds, rather than a key this test constructs to match
  // whatever overlapsAffected happens to accept, which would pass unchanged even if useBaseline's
  // own key still carried nothing but `on`.
  //
  // Refetch counts, not isInvalidated: both probes stay mounted, so both are active queries, and
  // an invalidated active query refetches immediately and clears its own isInvalidated the moment
  // that refetch settles, which the 20ms in settle() is long enough for. A second request for the
  // same anchor is what "this one got invalidated" looks like from outside once that has already
  // happened; a disjoint anchor that was never invalidated never earns a second one.
  it('refetches the baseline whose sixty day window overlaps affected, and leaves a disjoint one alone', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.includes('/overrides')) {
        return respond(200, { id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: true })
      }
      if (url.includes('/baselines')) { calls.push(url); return respond(200, { baseline: null }) }
      return respond(200, { items: [] })
    }) as typeof fetch

    const { tree } = withSession(<TwoBaselinesAndWriteButton input={INPUT} />)
    mount(tree)
    await settle()

    const overlappingCalls = () => calls.filter((u) => u.includes('on=2026-08-31')).length
    const disjointCalls = () => calls.filter((u) => u.includes('on=2026-01-31')).length
    // Both real requests actually fired once on mount, not a hope that the hook happened to ask
    // for them: an assertion below against a request that never went out would pass vacuously.
    expect(overlappingCalls()).toBe(1)
    expect(disjointCalls()).toBe(1)

    click()
    await settle()
    globalThis.fetch = original

    expect(overlappingCalls()).toBe(2)
    expect(disjointCalls()).toBe(1)
  })

  // affected: null means the target names a sample or a session no backfill has reached, so the
  // store marked no local day dirty at all: there is nothing derived that could be stale, even for
  // a cached range that happens to cover the day a reader would guess the override targets.
  it('invalidates nothing when affected is null, even for a range that would otherwise overlap', async () => {
    const { client, tree } = withSession(<WriteOverrideButton input={INPUT} />)
    const cached = queryKeys.resource('p1', 'series', {
      metrics: ['steps'], from: '2026-08-01', to: '2026-08-31', agg: 'sum',
    })
    client.setQueryData(cached, { steps: { points: [], reduction: null } })

    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, { id: 'o1', affected: null, applied: true })) as typeof fetch

    mount(tree)
    click()
    await settle()
    globalThis.fetch = original

    expect(client.getQueryState(cached)?.isInvalidated).toBe(false)
  })
})

describe('useWriteOverride, applied false', () => {
  // The write still saved (the store commits before the drain runs), but the derived numbers have
  // not caught up, so refetching a cached range would redraw exactly what is already on screen
  // while the panel is telling the reader the correction has not landed yet.
  it('leaves a range that overlaps affected alone', async () => {
    const { client, tree } = withSession(<WriteOverrideButton input={INPUT} />)
    const overlapping = queryKeys.resource('p1', 'series', {
      metrics: ['steps'], from: '2026-08-15', to: '2026-08-15', agg: 'sum',
    })
    client.setQueryData(overlapping, { steps: { points: [], reduction: null } })

    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, {
      id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: false,
    })) as typeof fetch

    mount(tree)
    click()
    await settle()
    globalThis.fetch = original

    expect(client.getQueryState(overlapping)?.isInvalidated).toBe(false)
  })

  // The case the coordinator's original brief would have left broken: the row is written to the
  // store before applyOverride ever runs (annotations.ts commits, then drains), so the overrides
  // list has a new row to show regardless of whether the drain caught up. Gating this refetch on
  // applied the way the date ranged invalidation is gated would mean a write that saved but did
  // not yet apply never reaches the management list at all.
  it('still refetches the overrides list itself, since the row exists whether or not the drain caught up', async () => {
    let overridesFetches = 0
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.includes('/overrides')) {
        return respond(200, { id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: false })
      }
      if (url.includes('/overrides')) {
        overridesFetches += 1
        return respond(200, { items: [] })
      }
      return respond(200, { items: [] })
    }) as typeof fetch

    const { tree } = withSession(<OverridesListAndWriteButton input={INPUT} />)
    mount(tree)
    await settle()
    expect(overridesFetches).toBe(1)

    click()
    await settle()
    globalThis.fetch = original

    expect(overridesFetches).toBe(2)
  })
})

describe('useWriteNote', () => {
  // A note carries no applied field and no drain: it takes effect the instant it commits, so
  // unlike an override write there is no gate to honour before refreshing the list that just
  // changed for this person.
  it('invalidates the notes resource for this person on success', async () => {
    const { client, tree } = withSession(<WriteNoteButton input={{ localDate: '2026-08-15', body: 'flew to Tokyo' }} />)
    const cached = queryKeys.resource('p1', 'notes', { from: '2026-08-01', to: '2026-08-31' })
    client.setQueryData(cached, { items: [] })

    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, { id: 'n1' })) as typeof fetch

    mount(tree)
    click()
    await settle()
    globalThis.fetch = original

    expect(client.getQueryState(cached)?.isInvalidated).toBe(true)
  })
})
