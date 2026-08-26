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
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { coverageFor } from './metricCoverage.js'

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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
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
          points: [{ localDate: '2026-08-15', value: 60, coverage: coverageFor(metric), sourceMix: null }],
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

/**
 * Fails every read the cards draw from, the way a 500, a bad source or a dropped connection
 * reaches this app: an ApiError out of apiSend, which leaves the query with isPending false and
 * data undefined. That is the same shape as a settled empty response, which is why every card
 * used to render "No data yet. Nothing has been recorded for this period." over a failure.
 */
function stubFailingReads(seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 500, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('a card whose request failed', () => {
  // The rule the whole branch is about, applied to the one case nothing on the page handled: a
  // 500 is not a statement about somebody's health record, and "Nothing has been recorded for
  // this period" is.
  it('says the request failed rather than that there is nothing recorded', async () => {
    const seen: string[] = []
    const restore = stubFailingReads(seen)
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('This did not load.')
    expect(container!.textContent).not.toContain('Nothing has been recorded for this period.')
    restore()
  })

  it('offers a retry that asks again', async () => {
    const seen: string[] = []
    const restore = stubFailingReads(seen)
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)

    const before = seen.filter((u) => u.includes('/series')).length
    const retry = container!.querySelector('.empty button') as HTMLButtonElement
    expect(retry.textContent).toBe('Try again')
    act(() => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    expect(seen.filter((u) => u.includes('/series')).length).toBeGreaterThan(before)
    restore()
  })
})

/**
 * One real night: distinct bed and wake minutes, unlike stubFetch's one-point-per-metric answer,
 * which hands sleep_bedtime_minutes and sleep_waketime_minutes the same value and so gets nulled
 * out by withinSchedule (wake <= bed) rather than counted as a drawn night.
 */
function stubOneNight(): () => void {
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
        const value = metric === 'sleep_bedtime_minutes' ? -30 : metric === 'sleep_waketime_minutes' ? 420 : 60
        body[metric] = {
          points: [{ localDate: '2026-08-15', value, coverage: coverageFor(metric), sourceMix: null }],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
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
    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws the band when the baseline is not thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 28, thin: false } })
    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // Not a placeholder and not a lie. No route serves typed events yet.
  it('shows flagged days as empty rather than wiring it to something event shaped', async () => {
    const restore = stubFetch({ baseline: null })
    // Through a real I18nProvider rather than asserting on the raw key: initReactI18next installs
    // whichever instance was created last as react-i18next's default, so a provider-less render
    // resolves the catalogue anyway once any other test in the file has mounted one, and the
    // assertion silently depended on this test running first.
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('No flagged days yet.')
    restore()
  })

  // The defect the stub above was hiding. Every sleep row the server can send carries
  // coverage: null, and reading that as a zero made the card render "Device not worn" over a
  // month of real nights while the mean was never drawn at all.
  it('draws the sleep mean over rows whose coverage is null rather than calling the device unworn', async () => {
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    // 60 minutes is what the stub answers for every metric, so this string belongs to the one
    // card that formats its value as a duration.
    expect(container!.textContent).toContain('1h 00m')
    expect(container!.textContent).not.toContain('Device not worn')
    restore()
  })

  // dashboard.sleepSchedule.basis had no plural form and 1 is reachable, the surviving instance
  // of the hazard M3d-1 fixed on the wear clause ("1 days not worn").
  it('renders the sleep schedule basis in the singular for one night', async () => {
    const restore = stubOneNight()
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    // Scoped to the sleep schedule's own basis text: dashboard.sleep's unrelated basis line also
    // reports against "nights" and, with this stub's single point, happens to read "1 of 31
    // nights" too.
    expect(container!.textContent).toContain('bed and wake time, 1 night')
    expect(container!.textContent).not.toContain('bed and wake time, 1 nights')
    restore()
  })

  it('does not import the fixtures', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('apps/web/src/pages/Dashboard.tsx', 'utf8')
    expect(source).not.toContain('fixtures/july')
  })
})
