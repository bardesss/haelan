// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { HeartRateCard } from '../src/pages/recovery/HeartRateCard.js'
import { Recovery } from '../src/pages/Recovery.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush, pumpUntil } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// Same reason dashboard-cards.test.tsx needs this: HeartRateRange and IntradayHeartRate draw for
// real here, and echarts.init's effect throws "missing chart token" without it.
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
  vi.useRealTimers()
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

type Baseline = { center: number, spread: number, n: number, thin: boolean } | null

const RANGE_DATES = ['2026-08-14', '2026-08-15', '2026-08-16']

/** The month-shaped default props every test below starts from, overridable per case. */
const DEFAULT_PROPS = {
  from: '2026-08-14', to: '2026-08-16', historicalTo: '2026-08-16', source: ALL_SOURCES,
  tab: 'month' as const, rangeDates: RANGE_DATES, period: '2026-08-14 to 2026-08-16',
  annotations: [], excluded: [], onDayClick: () => {}, onSampleClick: () => {}, span: 8,
}

/**
 * Answers every route HeartRateCard calls, mirroring dashboard-cards.test.tsx's own stubFetch
 * (this card used to be part of that page and drew from the same routes): the session, /series
 * for heart_rate under mean/min/max, /baselines, /intraday and /data-types.
 */
function stubFetch(opts: {
  baseline: Baseline, hangBaselines?: boolean, excludedDataTypes?: string[],
  emptyIntraday?: boolean, hangDataTypes?: boolean,
}): () => void {
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
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      if (opts.hangBaselines === true) return new Promise<Response>(() => {})
      return new Response(JSON.stringify({ baseline: opts.baseline }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/intraday')) {
      const date = new URLSearchParams(url.split('?')[1] ?? '').get('date') ?? '2026-08-15'
      return new Response(JSON.stringify({
        points: opts.emptyIntraday === true ? [] : [
          { sourceId: 'watch', utcMs: Date.parse(`${date}T08:00:00Z`), min: 58, mean: 62, max: 70, n: 1, excluded: false },
        ],
        reduction: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/data-types')) {
      if (opts.hangDataTypes === true) return new Promise<Response>(() => {})
      const excluded = new Set(opts.excludedDataTypes ?? [])
      return new Response(JSON.stringify({ items: [{ id: 'heart-rate', tier: 'intraday', excluded: excluded.has('heart-rate') }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/sync/status')) {
      return new Response(JSON.stringify({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the heart rate range band', () => {
  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no baseline band when the baseline is thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 3, thin: true } })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws the band when the baseline is not thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 28, thin: false } })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // The principle heartRateBasisKey's own comment states: "no baseline yet" is a claim about the
  // person's history, and an unanswered request makes no such claim. MetricCard gates the card on
  // the three heart rate series, /baselines settles separately, so the card draws while this one
  // is still in flight and the null branch spoke for it.
  it('does not claim there is no baseline while the baseline request is in flight', async () => {
    const restore = stubFetch({ baseline: null, hangBaselines: true })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // Gated on the basis line, not on the card's label: the pending branch renders the label too,
    // so waiting for "Heart rate range" can go true a tick before any basis exists.
    await pumpUntil(
      () => container!.textContent!.includes('daily minimum, mean and maximum'),
      'the heart rate range basis line',
    )
    const text = container!.textContent!
    expect(text).toContain('the baseline is still loading')
    expect(text).not.toContain('no baseline yet to compare against')
    restore()
  })

  // M3 phase review B2: hrBaseline itself moved to historicalTo (the date the band is really
  // computed against), but the basis line's own {{on}} kept reading the range end. This card's own
  // hrBaseline comment states the invariant this reopened: "the basis line used to report that
  // anchor date instead of the one the drawn band was really computed against."
  it('names the baseline\'s own anchor date in its basis line, not the range\'s own future end', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false } })
    const { client, tree } = withQuery(
      <HeartRateCard {...DEFAULT_PROPS} to="2026-09-30" historicalTo="2026-09-05" />,
    )
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const text = container!.textContent!
    expect(text).toContain('60 days before 2026-09-05')
    expect(text).not.toContain('60 days before 2026-09-30')
    restore()
  })
})

describe('the Day tab\'s intraday heart rate card', () => {
  // Finding 4 of the final review: the Day tab's intraday heart rate chart hand rolls its own
  // error/pending/empty order and used to have no exclusion check in it at all, so excluding
  // heart-rate rendered "No data yet" -- the untrue claim the empty-state work exists to prevent.
  it('says the excluded heart rate type was never synced, not that the day has no data', async () => {
    const restore = stubFetch({ baseline: null, excludedDataTypes: ['heart-rate'] })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} tab="day" from="2026-08-15" to="2026-08-15" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card?.textContent).toContain('Not being synced')
    expect(card?.textContent).not.toContain('No data yet')
    restore()
  })

  it('draws the intraday chart normally when heart rate is not excluded', async () => {
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} tab="day" from="2026-08-15" to="2026-08-15" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card?.textContent).not.toContain('Not being synced')
    expect(card?.textContent).not.toContain('No data yet')
    restore()
  })

  // The same cold-load race MetricCard's own gate exists for, in the one card that hand rolls its
  // exclusion check instead of going through it. excludedDataTypes is [] while /data-types is in
  // flight, which reads as "heart rate is not excluded", so an empty day hid this card for that
  // moment rather than saying it is not being synced.
  it('keeps the heart rate card while the exclusion list is still loading', async () => {
    const restore = stubFetch({ baseline: null, emptyIntraday: true, hangDataTypes: true })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} tab="day" from="2026-08-15" to="2026-08-15" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // pumpUntil, not flush: the whole point of this fixture is one request that never settles.
    await pumpUntil(
      () => container!.querySelector('.card') !== null,
      'the heart rate card to settle while the exclusion list hangs',
    )
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card).toBeDefined()
    expect(card?.textContent).not.toContain('No data yet')
    restore()
  })

  it('renders no heart rate card on a Day tab with no intraday samples', async () => {
    const restore = stubFetch({ baseline: null, emptyIntraday: true })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} tab="day" from="2026-08-15" to="2026-08-15" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card).toBeUndefined()
    restore()
  })
})

describe('mounted on Recovery', () => {
  const NO_REBUILD = NO_REBUILD_NEWS

  function stubRecovery(): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/series')) {
        const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
        const body: Record<string, unknown> = {}
        for (const metric of metrics) body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
        return json(body)
      }
      if (url.includes('/baselines')) return json({ baseline: null })
      if (url.includes('/insights')) return json(insightBody(url))
      if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD })
      return json({})
    }) as typeof fetch
    return () => { globalThis.fetch = original }
  }

  // Task 1's own point: Recovery now mounts the same card Dashboard has always drawn, at the foot
  // of its own grid.
  it('shows a card labelled Heart rate range', async () => {
    window.history.replaceState(null, '', '/recovery')
    const restore = stubRecovery()
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card).toBeDefined()
    restore()
  })
})
