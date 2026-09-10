// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Health } from '../src/pages/Health.js'
import { Weight } from '../src/pages/Weight.js'
import { Activity } from '../src/pages/Activity.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// Sparkline draws for real here, and echarts.init's effect throws "missing chart token" without
// this, the same reason every other page test file needs it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

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

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

type BaselineStub = { center: number, spread: number, n: number, thin: boolean } | null

/**
 * Answers every route Health calls, the same shape health-page.test.tsx's own stubHealth does,
 * with one difference: /baselines answers `baseline` rather than that file's fixed null, since
 * this file is the one that needs to vary it. week, not that file's own default day route: a one
 * day range takes MetricCard's oneDayRange branch and draws ChartNote in place of the sparkline,
 * which would leave no `[data-baseline-band]` marker to find whether or not one was ever passed.
 */
function stubHealth(baseline: BaselineStub): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const agg = params.get('agg')
      const body: Record<string, unknown> = {}
      for (const metric of params.getAll('metric')) {
        if (metric === 'spo2' && (agg === 'min' || agg === 'mean' || agg === 'max' || agg === 'count')) {
          body.spo2 = { points: [seriesPoint('spo2', '2026-08-14', 96)], reduction: null }
        } else if (metric === 'daily_spo2') {
          body.daily_spo2 = { points: [seriesPoint('daily_spo2', '2026-08-14', 96)], reduction: null }
        } else {
          body[metric] = { points: [], reduction: null }
        }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline })
    if (url.includes('/insights')) return json(insightBody(url))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same shape as weight-page.test.tsx's own stubWeight, with the same one difference stubHealth
 * above has: /baselines answers `baseline` rather than a fixed value.
 */
function stubWeight(baseline: BaselineStub): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) body[metric] = { points: [seriesPoint(metric, '2026-08-14', 81_200)], reduction: null }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline })
    if (url.includes('/insights')) return json(insightBody(url))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same shape as activity.test.tsx's own stubActivity, minus the provider-source distinction that
 * file's tests need and this one does not: every metric answers one worn point. Activity.tsx
 * never calls useBaseline (see this file's own "draws no band" test below for why), so unlike
 * stubHealth/stubWeight above this stub does not need a `baseline` parameter to vary; a `/baselines`
 * call from this page would itself be the defect the last test below checks for.
 */
function stubActivity(urls: string[] = []): () => void {
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
      for (const metric of metrics) body[metric] = { points: [seriesPoint(metric, '2026-08-14', 6000)], reduction: null }
      return json(body)
    }
    if (url.includes('/insights')) return json(insightBody(url))
    if (url.includes('/sessions')) return json({ items: [], cursor: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('baseline bands on the charts that gained one this task', () => {
  // The rule the band exists for, restated for daily_spo2: a band computed from a handful of days
  // looks exactly as authoritative as one computed from sixty, and thin is the reader's only
  // signal that it is not. Same assertion Recovery.tsx's own suite makes for its three cards.
  it('draws no band on the daily oxygen saturation card when the baseline is thin', async () => {
    window.history.replaceState(null, '', '/health?range=week&on=2026-08-14')
    const restore = stubHealth({ center: 96, spread: 1, n: 3, thin: true })
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Daily oxygen saturation')
    expect(card?.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws a band on the daily oxygen saturation card when the baseline is not thin', async () => {
    window.history.replaceState(null, '', '/health?range=week&on=2026-08-14')
    const restore = stubHealth({ center: 96, spread: 1, n: 28, thin: false })
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Daily oxygen saturation')
    expect(card?.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // The SpO2 interval card (Spo2Range) draws no band either way: that chart carries no baseline
  // prop at all (Spo2Range.tsx's own top comment says why -- min/mean/max on category axes has no
  // y position a band could sit behind, the same reason HeartRateRange has one and this chart's
  // own sibling does not), so a real, non-thin baseline for daily_spo2 must still leave it bare.
  it('leaves the oxygen saturation range chart bare even when daily_spo2 has a real baseline', async () => {
    window.history.replaceState(null, '', '/health?range=week&on=2026-08-14')
    const restore = stubHealth({ center: 96, spread: 1, n: 28, thin: false })
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Oxygen saturation range')
    expect(card?.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  // Same rule, restated for weight: this is the card the audit named ("Weight's trend"), the one
  // sibling metric on this page (body_fat) already carries a trend line of its own, and useTrend's
  // presence is not what gates the band -- useBaseline is a separate request, asked for weight
  // alone (Weight.tsx's own weightBaseline comment says why).
  it('draws no band on the weight card when the baseline is thin', async () => {
    window.history.replaceState(null, '', '/weight?range=week&on=2026-08-14')
    const restore = stubWeight({ center: 81_000, spread: 500, n: 3, thin: true })
    const { client, tree } = withQuery(<Weight />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Weight')
    expect(card?.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws a band on the weight card when the baseline is not thin', async () => {
    window.history.replaceState(null, '', '/weight?range=week&on=2026-08-14')
    const restore = stubWeight({ center: 81_000, spread: 500, n: 28, thin: false })
    const { client, tree } = withQuery(<Weight />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Weight')
    expect(card?.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // body_fat carries no trend and, by the same reasoning, no baseline: weightBand is asked for
  // 'weight' alone (REQUESTS.last covers both metrics, but only one of them names a baseline
  // query), so a real, non-thin weight baseline must not leak a band onto its sibling card.
  it('never draws a band on the body fat card, even while weight has a real baseline', async () => {
    window.history.replaceState(null, '', '/weight?range=week&on=2026-08-14')
    const restore = stubWeight({ center: 81_000, spread: 500, n: 28, thin: false })
    const { client, tree } = withQuery(<Weight />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Body fat')
    expect(card?.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  // Activity's steps do not get a band, and this pins why rather than leaving the omission
  // silent: the only chart this page draws steps on is ActivityHeatmap, a calendar of two category
  // axes (week, weekday) coloured by value, not a line on a value axis. The one band mechanism
  // this codebase has (an echarts markArea drawn against a y position, Sparkline and
  // HeartRateRange's shared `baseline` prop) has no equivalent on those axes, the same absence
  // Spo2Range already carries for its own min/mean/max chart. Adding one here would mean inventing
  // a second way to draw or suppress a band, which the brief this task follows rules out, so this
  // chart is left exactly as it draws today: no `/baselines` request at all, and no marker in its
  // output either.
  it('never requests a baseline or draws a band for steps, which has no chart that can hold one', async () => {
    const urls: string[] = []
    const restore = stubActivity(urls)
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(urls.some((u) => u.includes('/baselines'))).toBe(false)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })
})
