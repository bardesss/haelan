// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Recovery } from '../src/pages/Recovery.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush, pumpUntil } from './flush.js'
import { seriesPoint } from './metricCoverage.js'

// Sparkline draws for real here, and echarts.init's effect throws "missing chart token" without
// this, the same reason dashboard-cards.test.tsx and chart-lifecycle.test.tsx need it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/recovery')
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

type BaselineStub = { center: number, spread: number, n: number, thin: boolean } | null

/**
 * Answers every route Recovery calls: the session (seeded above, but a real render still asks it
 * once), /series for whichever metrics land in the one 'last' request, /api/sync/status (the
 * control row's own query, answered generically by the fallback below), and /baselines with
 * whichever baseline `baseline` names. One baseline for all three cards, since none of these tests
 * need them to differ.
 */
function stubRecovery(urls: string[], baseline: BaselineStub = null): () => void {
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
          points: [seriesPoint(metric, '2026-08-15', 60)],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same three routes as stubRecovery, but each of the three 'last' metrics answers its own
 * value rather than the shared 60 every other test in this file uses: the precision test above
 * needs the three cards to disagree, since a formatter that quietly used the same precision for
 * all three could not be told apart from one that reads each metric's own.
 */
function stubRecoveryPerMetric(values: Record<string, number>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', values[metric] ?? 60)], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Recovery page', () => {
  // All three metrics share an agg, so the page costs one round trip. Asserting the property
  // rather than a literal count: a pinned number once forced a chart to draw less than it claimed.
  it('asks for its three metrics in one request', async () => {
    const urls: string[] = []
    const restore = stubRecovery(urls)
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    expect(series).toHaveLength(1)
    expect(series[0]!.match(/metric=/g)).toHaveLength(3)
    restore()
  })

  // The refactor this task is for: card()'s headline used to thread a literal precision
  // (0, 0, 1) per call site rather than reading METRICS[metric].precision through
  // formatMetricValue. All three literals already matched the catalogue, so this cannot catch a
  // literal drifting from it by itself; what it does pin is that the rendered headline is the
  // catalogue's own rounding of an unrounded mean, which is what a broken formatMetricValue call
  // (or a reintroduced literal precision) would get wrong. Confirmed by reverting `card()`'s
  // formatMetricValue call back to `headline.toFixed(precision)` with precision hardcoded to 2:
  // this failed with "Received: 61.70" where it expects "62".
  it('rounds each headline to its own metric catalogue precision, not a copied-in literal', async () => {
    const restore = stubRecoveryPerMetric({
      resting_heart_rate: 61.7,
      daily_hrv: 45.3,
      respiratory_rate: 14.666666666666666,
    })
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const cardFor = (label: string) => [...container!.querySelectorAll('.card')]
      .find((card) => card.querySelector('.label')?.textContent === label)
    // resting_heart_rate and daily_hrv: catalogue precision 0, so a mean of 61.7/45.3 rounds away
    // its own decimal rather than keeping it.
    expect(cardFor('Resting heart rate')?.querySelector('.value')?.textContent).toContain('62')
    expect(cardFor('Heart rate variability')?.querySelector('.value')?.textContent).toContain('45')
    // respiratory_rate: catalogue precision 1, a many-decimal mean rounds to exactly one place,
    // the same value the reported bug's own fixture (format.test.ts) rounds to.
    expect(cardFor('Respiratory rate')?.querySelector('.value')?.textContent).toContain('14.7')
    restore()
  })

  it('reads daily_hrv, the once a day summary, not the intraday hrv series', async () => {
    const urls: string[] = []
    const restore = stubRecovery(urls)
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(urls.join()).toContain('metric=daily_hrv')
    expect(urls.join()).not.toMatch(/metric=hrv(&|$)/)
    restore()
  })

  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no band when the baseline is thin', async () => {
    const restore = stubRecovery([], { center: 60, spread: 4, n: 3, thin: true })
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  // The other half of the rule above: a real, non-thin baseline does draw one. The brief's own
  // sketch only asserted the thin case; asserting both is what tells the two branches apart,
  // rather than a test that would pass identically if the band were never drawn at all.
  it('draws a band when the baseline is not thin', async () => {
    const restore = stubRecovery([], { center: 60, spread: 4, n: 28, thin: false })
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // A rendered state, not a theoretical one: MetricCard gates on the series query, /baselines is a
  // separate request, and the card draws as soon as the first settles. baselineNote read
  // `data?.baseline ?? null` straight after the error test, so an in flight request came out
  // undefined and took the null branch, printing "no baseline yet to compare against" before
  // anything had been asked. The stub hangs /baselines forever rather than delaying it, so the
  // state under test is where this page rests rather than a moment it passes through.
  it('does not claim there is no baseline while the baseline request is in flight', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/baselines')) return new Promise<Response>(() => {})
      if (url.includes('/series')) {
        const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
        return json(Object.fromEntries(metrics.map((metric) => [metric, {
          points: [seriesPoint(metric, '2026-08-15', 60)],
          reduction: null,
        }])))
      }
      return json({})
    }) as typeof fetch
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // The card's own basis paragraph, not just its label: a label can render in the pending
    // branch (Dashboard's copy of this test proves it), and only a basis says the card is past
    // it. Scoped to the card under test so a sibling settling first cannot answer for it.
    await pumpUntil(
      () => [...container!.querySelectorAll('.card')].some((card) =>
        card.querySelector('.label')?.textContent === 'Resting heart rate' && card.querySelector('.basis') !== null),
      'the resting heart rate basis line',
    )
    const text = container!.textContent!
    expect(text).toContain('the baseline is still loading')
    expect(text).not.toContain('no baseline yet to compare against')
    globalThis.fetch = original
  })
})
