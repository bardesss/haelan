// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { useMetricGroups } from '../src/data/useMetricGroups.js'
import type { MetricGroups } from '../src/data/useMetricGroups.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { flush } from './flush.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', connected: true, baseUrl: 'http://localhost:4235',
}

/**
 * The session is seeded directly rather than fetched, following page-controls.test.tsx's pattern:
 * these tests are about how many /series requests a set of groups produces, and a live
 * /api/auth/me round trip ahead of them would be one more request to filter back out of that
 * count.
 */
function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

/**
 * Answers every /series call with an empty object: no key at all for any requested metric, the
 * shape a real response takes for a range nothing reported in (personQuery only ever writes a key
 * for a metric that actually has rows). None of the three tests below need a populated series: the
 * first two are about request shape and routing, and the third is specifically about the case
 * where a metric has no points, which this is, rather than a metric present with an empty `points`
 * array (a different shape: it would give `pointsOf` a real, and differently-identitied, array to
 * return instead of ever reaching the shared EMPTY fallback).
 */
function stubFetch(urls: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const GROUPS = [
  { agg: 'sum', metrics: ['steps', 'floors'] },
  { agg: 'last', metrics: ['resting_heart_rate'] },
] as const

let seen: MetricGroups | null = null
function Probe() {
  seen = useMetricGroups(GROUPS, { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES })
  return null
}

describe('useMetricGroups', () => {
  // One request per distinct agg, not one per metric. This is the property, not the number: a
  // pinned count once forced a chart to draw less than its basis line claimed.
  it('issues one request per distinct agg and batches the metrics that share one', async () => {
    const urls: string[] = []
    const restore = stubFetch(urls)
    const { client, tree } = withQuery(<Probe />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    const series = urls.filter((u) => u.includes('/series'))
    expect(series).toHaveLength(2)
    expect(series.filter((u) => u.includes('agg=sum'))[0]!.match(/metric=/g)).toHaveLength(2)
    restore()
  })

  it('routes a metric to the query for its own agg', async () => {
    const restore = stubFetch([])
    const { client, tree } = withQuery(<Probe />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    expect(seen!.queryFor('resting_heart_rate')).not.toBe(seen!.queryFor('steps'))
    restore()
  })

  // A fresh array each render is a new identity, and every chart keys its build callback on the
  // arrays it is handed, so an unstable empty would dispose and rebuild an echarts instance on
  // every commit.
  it('returns one stable empty array for a metric with no points', async () => {
    const restore = stubFetch([])
    const { client, tree } = withQuery(<Probe />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    expect(seen!.pointsOf('steps')).toBe(seen!.pointsOf('floors'))
    restore()
  })

  // 'floors' names a real card, not a typo: it is left out of `metrics` (what actually reaches
  // /series) the way Dashboard.tsx's `under()` leaves a catalogue-disallowed pairing off the wire,
  // but it still belongs to this group's `covers`, so its card resolves to this group's query and
  // renders its own empty state instead of the whole page either 500ing on a bad request or
  // throwing on a metric this hook was never told about.
  it('resolves a metric a group covers but does not request to no points, without throwing', async () => {
    const coveringGroups = [
      { agg: 'sum', metrics: ['steps'], covers: ['steps', 'floors'] },
    ] as const
    let coveringSeen: MetricGroups | null = null
    function CoveringProbe() {
      coveringSeen = useMetricGroups(coveringGroups, { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES })
      return null
    }

    const restore = stubFetch([])
    const { client, tree } = withQuery(<CoveringProbe />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    expect(() => coveringSeen!.queryFor('floors')).not.toThrow()
    expect(coveringSeen!.pointsOf('floors')).toEqual([])
    restore()
  })

  // A metric in neither `metrics` nor `covers` of any group is not a filtered-out card, it is a
  // card nobody told this hook about at all, which is the typo case the covering test above is
  // not: that one is left to throw on purpose, loud rather than a silent blank card.
  it('throws for a metric in neither list', () => {
    function TypoProbe() {
      useMetricGroups(GROUPS, { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES }).queryFor('not_a_real_metric')
      return null
    }
    // No fetch stub: the throw happens during render, before TanStack Query's effect would fire a
    // request, so there is nothing here for a stub to answer.
    expect(() => mount(withQuery(<TypoProbe />).tree)).toThrow(/not_a_real_metric/)
  })

  // The mistake `queryFor`'s own findIndex cannot see: two groups covering the same metric never
  // throws on its own, it just always resolves to whichever group came first, silently, no matter
  // which one a caller meant. heart_rate at min, mean and max in one call (a recovery page's own
  // range chart beside its tiles) is exactly this shape, so it has to fail at construction rather
  // than quietly binding every card asking for heart_rate to one of the three.
  it('throws at construction for a metric two groups both cover', () => {
    const overlapping = [
      { agg: 'min', metrics: ['heart_rate'] },
      { agg: 'max', metrics: ['heart_rate'] },
    ] as const
    function OverlapProbe() {
      useMetricGroups(overlapping, { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES })
      return null
    }
    expect(() => mount(withQuery(<OverlapProbe />).tree)).toThrow(/heart_rate/)
  })

  // The same silent-first-match mistake one level up: queryForAgg resolves an agg to a group by
  // findIndex too, so two groups requesting the same agg (a page building GROUPS from a per agg
  // loop that produced a duplicate) would silently bind every queryForAgg('sum') call to whichever
  // group came first, the exact bug the metric level check above exists to rule out.
  it('throws at construction for an agg two groups both request', () => {
    const duplicateAgg = [
      { agg: 'sum', metrics: ['steps'] },
      { agg: 'sum', metrics: ['sleep_asleep_minutes'] },
    ] as const
    function DuplicateAggProbe() {
      useMetricGroups(duplicateAgg, { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES })
      return null
    }
    expect(() => mount(withQuery(<DuplicateAggProbe />).tree)).toThrow(/sum/)
  })

  // queryForAgg reads a group's query by the agg it requested, not by naming one of its member
  // metrics as a stand in: a page whose sum group happens to include 'steps' should not have a
  // catalogue change to a wholly different metric break the one call site checking whether the
  // sum request as a whole is loading.
  it('reads a group by its own agg rather than by one of its metrics', async () => {
    const restore = stubFetch([])
    const { client, tree } = withQuery(<Probe />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    expect(seen!.queryForAgg('sum')).toBe(seen!.queryFor('steps'))
    expect(seen!.queryForAgg('last')).toBe(seen!.queryFor('resting_heart_rate'))
    restore()
  })

  it('throws for an agg nothing in this call requested', () => {
    function AggTypoProbe() {
      useMetricGroups(GROUPS, { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES }).queryForAgg('mean')
      return null
    }
    expect(() => mount(withQuery(<AggTypoProbe />).tree)).toThrow(/mean/)
  })
})
