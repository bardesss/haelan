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
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { SeriesPoint } from '../src/data/useSeries.js'
import type { Insight } from '../src/data/useInsight.js'
import { flush } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// Sparkline and Spo2Range both draw for real here, and echarts.init's effect throws "missing
// chart token" without this, the same reason recovery.test.tsx and chart-lifecycle.test.tsx need
// it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // range=day, on the same date every fixture below writes to: with no query params at all the
  // page defaults to the current month, and every fixture row this file writes for 2026-08-14
  // would fall outside it, rendering as a dense wall of "no reading" instead of the fixture.
  window.history.replaceState(null, '', '/health?range=day&on=2026-08-14')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

// A plain sync act(), not act(async () => ...): an async act call awaits its own callback's
// promise before returning, which here is enough time for the mocked fetch below (no real network
// delay, just a microtask chain) to both start AND finish before flush() ever takes its first
// sample. flush()'s own `sawFetch` guard then never arms, since queryClient.isFetching() reads 0
// on every poll, and the whole call spins for its entire internal ceiling before throwing "the
// page never settled." A plain sync act() only flushes the render's own synchronous effects, which
// is what leaves the fetch genuinely in flight by the time flush() begins polling, the same
// convention recovery.test.tsx's own mount() already follows.
function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

/**
 * One SpO2 day's four aggregate readings, each built through `seriesPoint` so every one of the
 * four rows this file stubs back carries the real shape Health.tsx's four separate spo2 requests
 * actually get: a real coverage (spo2 is intraday, so `seriesPoint`'s own `coverageFor` gives it
 * 0.9, a real watch's worth of samples, not a fictional "device not worn"), a real source and a
 * real updatedAtMs. One fabricated SeriesPoint standing in for all four aggs at once cannot carry
 * the shape a count agg (a small whole number of readings) and a mean agg (a percentage) both need
 * simultaneously, which is what let a card claiming "device not worn" over real spo2 data survive
 * thirteen reviews elsewhere in this project.
 */
function spo2Fixture(
  date: string, mean: number, extra: { min: number, max: number, count: number },
): { mean: SeriesPoint, min: SeriesPoint, max: SeriesPoint, count: SeriesPoint } {
  return {
    mean: seriesPoint('spo2', date, mean),
    min: seriesPoint('spo2', date, extra.min),
    max: seriesPoint('spo2', date, extra.max),
    count: seriesPoint('spo2', date, extra.count),
  }
}

/**
 * Answers every route Health calls: the session (seeded by withQuery, but a real render still
 * asks it once), /series for whichever agg each of Health's five requests names,
 * /api/sync/status, /overrides, /notes and /events. spo2 is routed by agg, not by metric name
 * alone: Health issues four separate spo2 requests (min, mean, max, count), and the four
 * `spo2Fixture` rows above carry different values for the identical metric name, so the agg on
 * the URL is what tells them apart.
 */
function stubHealth(
  urls: string[], spo2: ReturnType<typeof spo2Fixture>[], dailySpo2: SeriesPoint[],
  insightOverrides: Partial<Insight> = {},
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] } })
    }
    if (url.includes('/overrides')) return json({ items: [] })
    if (url.includes('/notes')) return json({ items: [] })
    if (url.includes('/events')) return json({ items: [] })
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const agg = params.get('agg')
      const body: Record<string, unknown> = {}
      for (const metric of params.getAll('metric')) {
        if (metric === 'spo2' && (agg === 'min' || agg === 'mean' || agg === 'max' || agg === 'count')) {
          body.spo2 = { points: spo2.map((day) => day[agg]), reduction: null }
        } else if (metric === 'daily_spo2') {
          body.daily_spo2 = { points: dailySpo2, reduction: null }
        } else {
          body[metric] = { points: [], reduction: null }
        }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    if (url.includes('/insights')) return json(insightBody(url, insightOverrides))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Health page', () => {
  // A week, not this file's own default day route: both cards take oneDayRange now, so on a one
  // day range each draws ChartNote in place of its chart and there are no chart tables to read a
  // cell out of at all (pages.test.tsx's Day tab describe pins that behaviour). The fixture still
  // writes one day, 2026-08-14, which sits inside this week, so the numbers below are unchanged;
  // only the basis line's denominator moves from one day to seven.
  it('draws the SpO2 interval and the daily summary, and names the reading count', async () => {
    window.history.replaceState(null, '', '/health?range=week&on=2026-08-14')
    const restore = stubHealth(
      [],
      [spo2Fixture('2026-08-14', 96.4, { min: 94, max: 99, count: 412 })],
      [seriesPoint('daily_spo2', '2026-08-14', 96)],
    )
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const html = container!.innerHTML
    const tables = [...html.matchAll(/<table class="sr-only">[\s\S]*?<\/table>/g)]
    expect(tables).toHaveLength(2)
    // The rendered cell, not a substring of it: formatNumber at precision 0 renders 412 as "412",
    // and toContain('412') would stay green even if a precision regression rendered "412.0".
    expect(tables[0]![0]).toContain('<td>412</td>')
    // The count column and the tooltip both had this reading count already; this test's own title
    // ("names the reading count") was true of neither until the visible basis line got it too
    // (spec section 4, "SpO2 with interval and count"). The clause is pluralised on the readings
    // themselves (412, so the plural form), which Health.tsx resolves before MetricCard ever sees
    // it precisely so the wear branch's own `count` cannot win the plural from it.
    expect(html).toContain('412 readings')
    expect(html).not.toContain('NaN')
    restore()
  })

  // spo2 needs four separate requests (min, mean, max, count all in one `agg` parameter each,
  // requireMetricAndAgg in packages/core/src/query/personQuery.ts rejects a call mixing them), and
  // daily_spo2 rides a fifth of its own under 'last'. Asserting the property rather than a pinned
  // request count: a merged request would silently answer with only one agg's worth of numbers for
  // all four series, which is exactly the defect this pins against.
  it('asks for spo2 under four separate aggs, not one merged request', async () => {
    const urls: string[] = []
    const restore = stubHealth(
      urls,
      [spo2Fixture('2026-08-14', 96, { min: 94, max: 98, count: 300 })],
      [seriesPoint('daily_spo2', '2026-08-14', 96)],
    )
    const { client, tree } = withQuery(<Health />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const spo2Urls = urls.filter((u) => u.includes('/series') && u.includes('metric=spo2') && !u.includes('daily_spo2'))
    const aggs = spo2Urls.map((u) => new URLSearchParams(u.split('?')[1] ?? '').get('agg')).sort()
    expect(aggs).toEqual(['count', 'max', 'mean', 'min'])
    restore()
  })

  // MetricCard's wear branch fires for spo2 because it is an intraday metric
  // (packages/core/src/api/catalogue.ts: tier 'intraday'), which is the fact
  // coverageIsWearSignal reads. 1/24 is the lowest coverage a real row can carry (coverage.ts
  // computes hours.size / 24, and a row is only emitted for at least one sample, so zero is not a
  // value the wire ever sends), and it sits at NOT_WORN_MAX_COVERAGE's own ceiling
  // (emptyState.ts), which reads as the device never having been worn that day and the empty
  // state says so rather than drawing an empty chart.
  it('says the device was not worn when every spo2 reading has the lowest possible coverage', async () => {
    const point = seriesPoint('spo2', '2026-08-14', 96, { coverage: 1 / 24 })
    const restore = stubHealth([], [{ mean: point, min: point, max: point, count: point }], [])
    const { client, tree } = withQuery(<Health />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('Device not worn')
    restore()
  })

  it('translates its labels and its wear clause into Dutch', async () => {
    const restore = stubHealth(
      [],
      [spo2Fixture('2026-08-14', 96, { min: 94, max: 98, count: 300 })],
      [seriesPoint('daily_spo2', '2026-08-14', 96)],
    )
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const text = container!.textContent!
    expect(text).toContain('Zuurstofsaturatiebereik')
    expect(text).toContain('Dagelijkse zuurstofsaturatie')
    expect(text).not.toMatch(/\bhealth\.[a-zA-Z][a-zA-Z.]*\b/)
    restore()
  })

  // Task 4's own insight card. The daily summary card above carries a "%" suffix through
  // StatTile's own unit prop; dailySpo2InsightFormat is what closes the gap InsightCard's default
  // formatMetricValue call leaves (no unit at all), the same gap Recovery.tsx's own
  // restingHrInsightFormat closes for its identically shaped card.
  it('carries the daily summary tile\'s own percent suffix into its insight sentence', async () => {
    window.history.replaceState(null, '', '/health?range=month&on=2026-08-15')
    const restore = stubHealth(
      [],
      [spo2Fixture('2026-08-14', 96, { min: 94, max: 98, count: 300 })],
      [seriesPoint('daily_spo2', '2026-08-14', 96)],
      { current: 96.4, previous: 95.8, delta: 0.6 },
    )
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Daily oxygen saturation, this period against the last')
    // "96.4 %" with a space, not "96.4%": StatTile's own unit prop always renders a space before
    // the unit (StatTile.tsx's `<span> {unit}</span>`), the same convention this card's own
    // dailySpo2InsightFormat follows so it reads the same as the tile beside it.
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '96.4 % on average (Aug 1, 2026 to Aug 31, 2026) against 95.8 % on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 0.6 %.',
    )
    restore()
  })

  // Vary the fixture rather than reusing the same complete body every test in this file: a
  // suppressed response (current/previous/delta all null) is a null field this card has to gate on
  // rather than reach formatMetricValue with, which a fixture carrying only complete bodies could
  // never catch. The gate now removes the whole card instead of swapping in an empty state, so the
  // absent .card element is both halves of the claim: nothing was formatted, and nothing was drawn.
  // This is a thin-days suppression specifically; thin-coverage is the deliberate exception that
  // keeps its card, pinned separately in insight-card.test.tsx.
  it('hides the daily summary insight card on a thin-days suppression', async () => {
    const restore = stubHealth(
      [], [], [],
      { suppressed: true, reason: 'thin-days', current: null, previous: null, delta: null },
    )
    const { client, tree } = withQuery(<Health />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Daily oxygen saturation, this period against the last')
    expect(card).toBeUndefined()
    restore()
  })
})
