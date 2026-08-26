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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
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
})
