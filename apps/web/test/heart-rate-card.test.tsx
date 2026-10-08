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
import { seriesPoint } from './metricCoverage.js'
import { RECOVERY_PERIOD_MONTH } from './fixtures/recoveryPeriod.js'

// Same reason dashboard-cards.test.tsx needs this: HeartRateRange draws for real here, and
// echarts.init's effect throws "missing chart token" without it.
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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
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
  rangeDates: RANGE_DATES, period: '2026-08-14 to 2026-08-16', periodWords: 'this month',
  annotations: [], excluded: [], onDayClick: () => {}, span: 8,
}

/**
 * Answers every route HeartRateCard calls, mirroring dashboard-cards.test.tsx's own stubFetch
 * (this card used to be part of that page and drew from the same routes): the session, /series
 * for heart_rate under mean/min/max, and /baselines.
 */
function stubFetch(opts: { baseline: Baseline, hangBaselines?: boolean, asked?: string[] }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    opts.asked?.push(url)
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
    expect(text).toContain('your usual range is still loading')
    expect(text).not.toContain('no usual range yet')
    restore()
  })

  // M3 phase review B2: the band is computed against historicalTo, not the range's own future end.
  // The caption names no date any more (it says what the band is, as the page's other captions do),
  // so the guard holds the request itself to that anchor.
  it('asks for the band at historicalTo, not the end of the range, and captions it under the chart', async () => {
    const asked: string[] = []
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false }, asked })
    const { client, tree } = withQuery(
      <HeartRateCard {...DEFAULT_PROPS} to="2026-09-30" historicalTo="2026-09-05" />,
    )
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const baselines = asked.filter((url) => url.includes('/baselines'))
    expect(baselines.length).toBeGreaterThan(0)
    expect(baselines.every((url) => url.includes('on=2026-09-05'))).toBe(true)
    // Under the chart, as a caption, and no basis line in the card's header.
    expect(container!.querySelector('.basis')).toBeNull()
    const caption = container!.querySelector('.card .dash-caption')
    expect(caption?.textContent).toBe('daily minimum, mean and maximum, every day this month · band = your usual range')
    // After the chart in the card, not above it.
    const chart = container!.querySelector('.card [role="img"]')!
    expect(chart.compareDocumentPosition(caption!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    restore()
  })

  it('words its caption in Dutch', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false } })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} periodWords="deze maand" />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('.card .dash-caption')?.textContent)
      .toBe('dagelijks minimum, gemiddelde en maximum, elke dag deze maand · band = je gebruikelijke bereik')
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
      if (url.includes('/recovery/period')) return json(RECOVERY_PERIOD_MONTH)
      if (url.includes('/series')) {
        const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
        const body: Record<string, unknown> = {}
        for (const metric of metrics) body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
        return json(body)
      }
      if (url.includes('/baselines')) return json({ baseline: null })
      if (url.includes('/notes')) return json({ items: [{ id: 'n1', localDate: '2026-08-15', body: 'Slept at a friend', updatedAtMs: 0 }] })
      if (url.includes('/events')) {
        return json({ items: [{
          id: 'e1', kind: 'caffeine', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
          endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-15',
        }] })
      }
      if (url.includes('/overrides')) return json({ items: [] })
      if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD })
      return json({})
    }) as typeof fetch
    return () => { globalThis.fetch = original }
  }

  // Recovery mounts the card the old Dashboard drew at its own foot, across the whole row of the
  // overview's grid. Its Day tab draws no trace: it opens the dashboard on that day
  // (recovery.test.tsx), and the dashboard's day carries the trace.
  it('shows a card labelled Heart rate range, the whole row wide', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery()
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll<HTMLElement>('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card?.dataset.span).toBe('12')
    restore()
  })

  // The overview pages draw no day notes or events on their charts: on a year they piled into one
  // unreadable block. Notes and events stay reachable from the hero's day panel.
  it('draws no day note or event on the range, and captions it by the period', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery()
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll<HTMLElement>('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')!
    expect(card.querySelector('table')).not.toBeNull()
    expect(card.innerHTML).not.toContain('Slept at a friend')
    expect(card.innerHTML).not.toContain('Caffeine')
    expect(card.querySelector('.dash-caption')?.textContent)
      .toBe('daily minimum, mean and maximum, every day this month · no usual range yet')
    restore()
  })
})
