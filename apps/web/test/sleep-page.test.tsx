// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Sleep } from '../src/pages/Sleep.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { coverageFor } from './metricCoverage.js'

// Sparkline draws for real here, and echarts.init's effect throws "missing chart token" without
// this, the same reason activity.test.tsx and recovery.test.tsx need it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/sleep')
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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

/**
 * Answers every route Sleep calls: the session, /series for whichever metrics land in each of the
 * three groups, /api/sync/status (the control row's own query, answered generically by the
 * fallback below) and /baselines for sleep_asleep_minutes' own baseline. Every sleep metric is
 * handed 420 (7h 00m), not the 60 Activity.tsx and Recovery.tsx use for their own metrics: 420
 * both reads as a plausible night's sleep, unlike 60, and is the same value regardless of which
 * of this page's cards compute a mean and which compute a sum, since every stubbed metric here
 * carries exactly one point.
 *
 * coverageFor is read off metricCoverage.ts rather than written as a literal here: every sleep
 * metric there answers null, because packages/core/src/derive/sleep.ts writes coverage null for
 * every sleep row on purpose (a night has no samples underneath it), and a stub that could not
 * express that shape is the exact gap that let a null coverage render as "device not worn" over a
 * fully populated month through thirteen task reviews.
 */
function stubSleep(urls: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: [{ localDate: '2026-08-15', value: 420, coverage: coverageFor(metric), sourceMix: null }],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Sleep page', () => {
  // The shape that produced M3d-1's Critical: sleep rows carry a null coverage because a night
  // has no samples underneath it, and reading that as zero rendered "device not worn" over a
  // fully populated month.
  it('draws a populated month rather than calling the device unworn', async () => {
    const restore = stubSleep([])
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).not.toContain('emptyState.not_worn.title')
    expect(container!.textContent).toContain('7h 00m')
    restore()
  })

  it('does not import the fixtures', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('apps/web/src/pages/Sleep.tsx', 'utf8')
    expect(source).not.toContain('fixtures/july')
  })

  // M3d-1 left this page with a working Sync button beside range buttons that did nothing, and a
  // hardcoded "Synced 12 min ago" on an instance that may have synced seconds ago.
  it('drives the control row from the URL rather than a stub', async () => {
    const restore = stubSleep([])
    window.history.replaceState(null, '', '/sleep?range=week&on=2026-08-15')
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const pressed = [...container!.querySelectorAll('.segment')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.textContent).toContain('controlRow.ranges.week')
    restore()
  })

  // Only three requests regardless of eleven cards: /series takes one agg per call, and this page
  // groups its metrics into sum, last and count, the same REQUESTS/under('agg') shape Recovery.tsx
  // and Activity.tsx already use.
  it('batches by agg, so the request count is the number of distinct aggs', async () => {
    const urls: string[] = []
    const restore = stubSleep(urls)
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    const aggs = new Set(series.map((u) => new URLSearchParams(u.split('?')[1] ?? '').get('agg')))
    expect(series).toHaveLength(aggs.size)
    expect(aggs).toEqual(new Set(['sum', 'last', 'count']))
    restore()
  })

  // The other half of the shared sleep.stage keys this page reuses from the fixture era Sleep.tsx
  // (deep/light/rem/awake stage names), now carried by the deep/light/rem/awake minute cards
  // rather than a hypnogram legend: pages.test.tsx used to pin this against that legend, which
  // this task removes along with the rest of the fixture backed chart it belonged to, so the claim
  // that stage names go through the shared keys and not a second, English-only set moves here.
  it('translates sleep stage names through the shared sleep.stage keys, not a second set', async () => {
    const restore = stubSleep([])
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('Diep')
    expect(container!.innerHTML).not.toContain('>Deep<')
    restore()
  })
})
