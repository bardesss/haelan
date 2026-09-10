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
import { flush } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'
import { ALL_SOURCES } from '../src/controls/source.js'

// happy-dom applies no stylesheet, so document.documentElement carries none of app.css's chart
// custom properties. Every other happy-dom test in this suite sidesteps that by never mounting a
// chart host for real; this one does, because the round trip has to run through an actual
// Sparkline to be the round trip. Without this, echarts.init's effect throws "missing chart
// token" the moment the steps card (the one card the stub gives real points for) draws.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Each test drives its own history. Without this a test inherits whatever the previous one
  // navigated to, which is the kind of order dependence that only shows up when a file is run
  // on its own months later.
  window.history.replaceState(null, '', '/')
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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * A client that does not retry and never treats cached data as stale, following
 * page-controls.test.tsx's pattern: the session is seeded directly rather than fetched, so the
 * page mounts without a real /api/auth/me round trip.
 */
function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

/** Answers the session and the series, so the page can mount without a server. */
function stubFetch(seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify({
        personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true,
        timezone: 'Europe/Amsterdam',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      return new Response(JSON.stringify({
        steps: { points: [seriesPoint('steps', '2026-08-01', 900)], reduction: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/intraday')) {
      // Empty rather than a real point: none of this file's tests read the intraday chart itself,
      // only that mounting the Day tab does not crash or print a NaN, which an empty series answers
      // as well as a populated one and without inventing a shape this file otherwise never checks.
      return new Response(JSON.stringify({ points: [], reduction: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Answers every requested metric with exactly one point, rather than the fixed `steps`-only body
 * `stubFetch` returns. A single canned metric leaves three of the four cards empty (no data, no
 * trend() call at all) regardless of range, which would prove nothing about the day range
 * specifically. This lets every card reach trend() with a one-point series, which is what the
 * day range actually hands it.
 */
function stubFetchOnePointPerMetric(seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify({
        personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true,
        timezone: 'Europe/Amsterdam',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: [seriesPoint(metric, '2026-08-15', 100)],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/intraday')) {
      // Empty rather than a real point: none of this file's tests read the intraday chart itself,
      // only that mounting the Day tab does not crash or print a NaN, which an empty series answers
      // as well as a populated one and without inventing a shape this file otherwise never checks.
      return new Response(JSON.stringify({ points: [], reduction: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Answers /series with a sourceMix that depends on whether the request's own `source` parameter
 * is present, the way the real store does: rollup.ts writes sourceMix: null for every per source
 * rollup and only mergeDay's merged rows carry a real mix, and preferMerged answers a merged row
 * only when the caller omits `source` (the all sources sentinel). A stub that always returned the
 * same sourceMix regardless of source could not catch the bug this file's "keeps a picked device"
 * test exists for, since that bug is specifically the selector losing the mix the instant a
 * request stops asking for every source.
 */
function stubFetchBySource(seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify({
        personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true,
        timezone: 'Europe/Amsterdam',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const metrics = params.getAll('metric')
      const source = params.get('source')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: [source === null
            ? seriesPoint(metric, '2026-08-15', 100, { sourceMix: JSON.stringify([{ source: 'watch', hours: 24 }]) })
            : seriesPoint(metric, '2026-08-15', 100, { source: 'watch' })],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/intraday')) {
      // Empty rather than a real point: none of this file's tests read the intraday chart itself,
      // only that mounting the Day tab does not crash or print a NaN, which an empty series answers
      // as well as a populated one and without inventing a shape this file otherwise never checks.
      return new Response(JSON.stringify({ points: [], reduction: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Dashboard round trip', () => {
  // The whole behaviour, across both units: the control row pushes a parameter, the URL changes,
  // the hook re-parses it, the query key changes, and a new request goes out for the new range.
  // Tasks 5 and 8 can each be green while this is broken.
  it('refetches for the new range when the control row changes the tab', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')

    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    const before = seen.filter((u) => u.includes('/series')).length
    const week = [...container!.querySelectorAll('.segment')][1] as HTMLButtonElement
    act(() => { week.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(client, () => container!.innerHTML)

    expect(window.location.search).toContain('range=week')
    const after = seen.filter((u) => u.includes('/series'))
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)).toContain('from=2026-08-10')
    restore()
  })

  // Not "one request for every card metric": /series takes exactly one agg for the whole call, and
  // a metric only has rows under the aggs its own catalogue entry lists, so one shared request
  // would ask at least one card for an agg its metric refuses and 400 the lot
  // (requireMetricAndAgg's ConfigError). What batching by agg actually buys is fewer requests than
  // cards: metrics that share an agg ride together.
  //
  // Asserted as a property, not a count. The number of distinct aggs the dashboard needs is a
  // detail of which cards exist and what each draws (task 10 added two more requests, 'min' and
  // 'max', so the range card could draw a real band instead of a bare mean line), and a count
  // pinned here is a count someone has to remember to update every time a card's data needs
  // change, or worse, a count that quietly starts arguing a chart out of a series it should draw
  // rather than the other way around. What is actually worth defending: requests are batched by
  // agg (one request per distinct agg value, not one per metric), and that is fewer requests than
  // there are cards on the page.
  it('batches by shared agg rather than firing one request per card', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')

    mount(withQuery(<Dashboard />).tree)
    await act(async () => { await Promise.resolve() })

    const seriesCalls = seen.filter((u) => u.includes('/series'))
    const distinctAggs = new Set(seriesCalls.map((u) => new URLSearchParams(u.split('?')[1] ?? '').get('agg')))
    const cardCount = container!.querySelectorAll('.card').length
    // One request per distinct agg: if two metrics sharing an agg fired separate requests instead
    // of riding one together, seriesCalls.length would exceed distinctAggs.size.
    expect(seriesCalls).toHaveLength(distinctAggs.size)
    expect(seriesCalls.length).toBeLessThan(cardCount)
    expect(seriesCalls.some((u) => u.match(/metric=/g)!.length > 1)).toBe(true)
    restore()
  })

  // The batching test above only pins that requests are grouped by agg, which three requests
  // satisfy as happily as five: it has no opinion on which aggs the page actually asks for. This
  // is what stops a future change quietly dropping 'min' and 'max' to save a round trip and
  // reproducing the exact defect fixed once already, the heart rate range card naming three
  // series in its basis line while drawing one.
  it('fetches heart_rate under min and max, not only mean', async () => {
    const seen: string[] = []
    const restore = stubFetch(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')

    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    const seriesCalls = seen.filter((u) => u.includes('/series'))
    const aggs = seriesCalls.map((u) => new URLSearchParams(u.split('?')[1] ?? '').get('agg'))
    expect(aggs).toContain('min')
    expect(aggs).toContain('max')
    restore()
  })

  // datesFor('day', anchor) returns from === to, so every card's series is exactly one point on
  // this range, the case trend() used to divide 0 by 0 for. Checked end to end through the real
  // page rather than only at trend()'s own unit tests, since that is the path the coordinator's
  // review flagged as the one that actually reaches the bug in production.
  it('renders the day range with no NaN or Infinity delta on any card', async () => {
    const seen: string[] = []
    const restore = stubFetchOnePointPerMetric(seen)
    window.history.replaceState(null, '', '/dashboard?range=day&on=2026-08-15')

    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    // 5 stat tiles (steps, resting heart rate, sleep, mean heart rate, and recovery since the M3
    // phase review's B3 fix turned it into a fifth tile() card reading daily_hrv) plus the five
    // remaining non-tile cards task 10 restored (heart rate range, flagged days, sleep stages,
    // sleep schedule, anomalies), plus the three insight cards this task added (steps,
    // resting_heart_rate, sleep_asleep_minutes), 13 not 4 or 10: this test predates all of their
    // returns and only ever meant "every card on the page", not "exactly the tiles". Daily steps
    // (the heatmap) is not among them any more: M3d2 moved it to Activity.tsx.
    expect(container!.querySelectorAll('.card')).toHaveLength(13)
    expect(container!.innerHTML).not.toContain('NaN')
    expect(container!.innerHTML).not.toContain('Infinity')
    // Not just absent text: no delta chip should exist at all for a window with one point, since
    // there is no earlier half to compare it against.
    expect(container!.querySelectorAll('.delta')).toHaveLength(0)
    restore()
  })

  // Every card link, not the two that already did it. The sleep card stayed plain on a comment
  // saying /sleep "is still pinned to the July fixtures and ignores every parameter it is handed",
  // which this milestone made untrue: Sleep.tsx reads usePageControls the same as the others. A
  // reader on a month view following that one link landed back on the default period while the two
  // links beside it carried theirs. Checking every .card-link rather than naming three keeps a
  // fourth from arriving plain.
  it('carries the reader\'s period into every card link', async () => {
    const seen: string[] = []
    const restore = stubFetchOnePointPerMetric(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')

    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    const links = [...container!.querySelectorAll('a.card-link')]
    expect(links.length).toBeGreaterThan(2)
    expect(links.map((a) => a.getAttribute('href')!.split('?')[0])).toContain('/sleep')
    for (const link of links) {
      const href = link.getAttribute('href')!
      const params = new URLSearchParams(href.split('?')[1] ?? '')
      expect(params.get('range'), href).toBe('month')
      expect(params.get('on'), href).toBe('2026-08-15')
    }
    restore()
  })

  // The regression this exists for: distinctSources used to be fed the range scoped queries,
  // which fetch under whatever source the control row has selected, so picking a real device
  // wiped out every sourceMix the selector reads and the select silently fell back to "All
  // sources" while the numbers on screen stayed device filtered. The fix reads a query pinned to
  // the all sources sentinel instead of whatever the reader picked.
  it('keeps a picked device selected and offered in the source selector', async () => {
    const seen: string[] = []
    const restore = stubFetchBySource(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15&source=watch')

    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    const select = container!.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toContain('watch')
    expect(select.value).toBe('watch')
    restore()
  })

  // The defect the earlier fix went in the wrong layer to close. resolveSource corrected what
  // the select showed and left the page building `range` from the raw controls.source, so a
  // stale or foreign link read "All sources" above cards querying somebody else's device name.
  it('queries the merged rows for a source this person does not have, not the foreign name', async () => {
    const seen: string[] = []
    const restore = stubFetchBySource(seen)
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15&source=someone-elses')

    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    const seriesCalls = seen.filter((u) => u.includes('/series'))
    expect(seriesCalls.length).toBeGreaterThan(0)
    expect(seriesCalls.some((u) => u.includes('source=someone-elses'))).toBe(false)
    // The baseline is a separate route reading the same resolved value.
    expect(seen.some((u) => u.includes('/baselines') && u.includes('source=someone-elses'))).toBe(false)
    const select = container!.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe(ALL_SOURCES)
    restore()
  })

  it('does not import the fixtures', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile('apps/web/src/pages/Dashboard.tsx', 'utf8'))
    expect(source).not.toContain('fixtures/july')
  })
})
