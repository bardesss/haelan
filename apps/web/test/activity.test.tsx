// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Activity } from '../src/pages/Activity.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { coverageFor, PROVIDER_METRICS } from './metricCoverage.js'

// Sparkline and ActivityHeatmap draw for real here, and echarts.init's effect throws "missing
// chart token" without this, the same reason every other page test file needs it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/activity')
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
 * Answers every route Activity calls. /series behaves the way the real store does for the two
 * provider-only metrics rather than handing back the same canned point regardless of source:
 * packages/core/test/person-query.test.ts's own "returns only merged rows when merged is named"
 * pins that an explicit `source` filters to rows carrying that exact value, and floors and
 * total_calories are written only as `provider` rows (0 of 211 and 0 of 731 merged in the live
 * database Task 1's brief measured), so a call that names any explicit source gets nothing back
 * for either. A stub that answered them the same regardless of source could not tell "this page
 * omits the parameter" apart from "the parameter happens not to matter here", which is the whole
 * point of the first test below.
 */
function stubActivity(urls: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const metrics = params.getAll('metric')
      const explicitSource = params.get('source')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        const isProvider = PROVIDER_METRICS.has(metric)
        body[metric] = {
          points: isProvider && explicitSource !== null ? [] : [{
            localDate: '2026-08-15',
            value: 60,
            coverage: coverageFor(metric),
            source: isProvider ? 'provider' : 'merged',
            sourceMix: null,
          }],
          reduction: null,
        }
      }
      return json(body)
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Activity page', () => {
  // The two provider only metrics are the reason Task 1 of this milestone exists. If the request
  // carried a source parameter at all, both would come back empty here (see stubActivity's own
  // comment on why), which is the defect that milestone closed: usePageControls and resolveSource
  // default to the all sources sentinel, and sourceParam omits the parameter for it.
  it('asks for floors and total_calories with no source parameter', async () => {
    const urls: string[] = []
    const restore = stubActivity(urls)
    const { client, tree } = withQuery(<Activity />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    expect(series.join()).toContain('metric=floors')
    expect(series.join()).toContain('metric=total_calories')
    for (const url of series) expect(url).not.toContain('source=')
    restore()
  })

  // Drawn, not merely absent from the not-worn branch: the failure this page exists to avoid is
  // an empty state (of any kind) standing in for real data, and "not_worn does not appear" alone
  // would not catch a regression that swapped it for no_data instead. floors' coverage is neither
  // once-a-day (1/24) nor null: it is a daily-tier provider rollup, and coverageIsMeaningful only
  // ever says true for a continuously sampled (intraday) metric, so its wear branch can never fire
  // regardless of the coverage number a stub hands it; drawing the real value is the assertion
  // that actually exercises the card.
  it('draws provider rows rather than calling them unworn', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).not.toContain('Device not worn')
    expect(container!.textContent).toContain('Floors climbed')
    expect(container!.textContent).toContain('Total calories')
    expect(container!.querySelector('.empty')).toBeNull()
    restore()
  })

  // Not "one request per card": /series takes one agg for a whole call, so cards sharing an agg
  // ride together. Two aggs on this page (sum and count, workout_count being the one metric whose
  // only aggregate is count), so two requests regardless of how many cards draw from them.
  it('batches by agg, so the request count is the number of distinct aggs', async () => {
    const urls: string[] = []
    const restore = stubActivity(urls)
    const { client, tree } = withQuery(<Activity />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    const aggs = new Set(series.map((u) => new URLSearchParams(u.split('?')[1] ?? '').get('agg')))
    expect(series).toHaveLength(aggs.size)
    restore()
  })

  // The heatmap's own dense denominator, carried over from dashboard-cards.test.tsx's equivalent
  // check when the card moved here: /series omits a day with no row entirely, so points.length is
  // "days that reported", and a month missing most of its days must not read "1 of 1 days worn".
  it('states the heatmap total against every calendar day in range, not just the days that reported', async () => {
    window.history.replaceState(null, '', '/activity?range=month&on=2026-08-15')
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const match = container!.textContent!.match(/(\d+) of (\d+) days worn/)
    expect(match).not.toBeNull()
    expect(Number(match![2])).toBeGreaterThan(1)
    restore()
  })

  // Carried over from pages.test.tsx's own "states the heatmap colour domain" assertion, which
  // the previous round deleted without replacing: that assertion pinned two claims the denominator
  // test above does not touch at all, the maxSteps interpolation and the static "stronger colour"
  // copy, and a broken interpolation or a dropped clause would have passed every other test in
  // this file. stubActivity answers every metric with a single point at value 60, so 60 is both
  // the sum and the maximum steps reads for the one day it reports.
  it('states the heatmap colour domain from the steps it actually drew', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('0 to 60 steps')
    expect(container!.textContent).toContain('stronger colour is more steps')
    restore()
  })

  // The other half of pages.test.tsx's own language parity check that the heatmap's move left
  // uncovered: ActivityHeatmap is the only chart anywhere in this app that renders a weekday
  // column, so with it gone from Dashboard, translating that column into Dutch was exercised
  // nowhere at all once the heatmap-specific pages.test.tsx assertion was removed.
  it('translates the heatmap weekday column into Dutch', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.innerHTML).toContain('Weekdag')
    expect(container!.innerHTML).not.toContain('>Weekday<')
    restore()
  })
})
