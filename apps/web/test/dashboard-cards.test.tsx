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

// Same reason dashboard-round-trip.test.tsx needs this: HeartRateRange and the other restored
// charts draw for real here, and echarts.init's effect throws "missing chart token" without it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

/**
 * Waits until the mounted tree stops changing, rather than a fixed number of ticks. This page
 * fires five independent queries (three series groups, a baseline, sleep nights), each its own
 * fetch-then-parse chain, and a single microtask tick is not enough hops for all five to settle;
 * a fixed tick count that happened to be enough for one query was still a race against the
 * others, which is exactly how "draws the band when not thin" passed on some runs and failed on
 * others against the same, correct code. Polling until two consecutive snapshots of the rendered
 * HTML agree is a wait for "nothing left pending" that does not have to name which query it is
 * waiting on.
 */
async function flush(): Promise<void> {
  let previous: string | null = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    const current = container!.innerHTML
    if (current === previous) return
    previous = current
  }
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

type Baseline = { center: number, spread: number, n: number, thin: boolean } | null

/**
 * Answers every route the Dashboard now calls: the session (seeded above, but a real render still
 * asks it once), /series for every requested metric, /sleep/nights, and /baselines with whichever
 * baseline the test wants. One canned point per metric, the same way
 * dashboard-round-trip.test.tsx's stubFetchOnePointPerMetric does, so heart_rate has something to
 * plot and the band, when the baseline says to draw one, has an axis to sit on.
 */
function stubFetch(opts: { baseline: Baseline }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: [{ localDate: '2026-08-15', value: 60, coverage: 0.9, sourceMix: null }],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: opts.baseline }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the remaining Dashboard cards', () => {
  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no baseline band when the baseline is thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 3, thin: true } })
    mount(withQuery(<Dashboard />))
    await flush()
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws the band when the baseline is not thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 28, thin: false } })
    mount(withQuery(<Dashboard />))
    await flush()
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // Not a placeholder and not a lie. No route serves typed events yet.
  it('shows flagged days as empty rather than wiring it to something event shaped', async () => {
    const restore = stubFetch({ baseline: null })
    mount(withQuery(<Dashboard />))
    await flush()
    // No I18nProvider in this tree, the same way dashboard-round-trip.test.tsx mounts it: without
    // one react-i18next has no catalogue to resolve against and renders the key itself, which is
    // what this asserts on rather than the English prose.
    expect(container!.textContent).toContain('dashboard.flaggedDays.emptyTitle')
    restore()
  })

  it('does not import the fixtures', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('apps/web/src/pages/Dashboard.tsx', 'utf8')
    expect(source).not.toContain('fixtures/july')
  })
})
