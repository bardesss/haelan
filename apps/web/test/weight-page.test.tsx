// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { SeriesPoint } from '../src/data/useSeries.js'
import { Weight } from '../src/pages/Weight.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { seriesPoint } from './metricCoverage.js'

// Sparkline draws for real here, and echarts.init's effect throws "missing chart token" without
// this, the same reason recovery.test.tsx and health-page.test.tsx need it.
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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

/**
 * Answers the session, /series for whichever metrics land in Weight's one 'last' request (from
 * `series`, keyed by metric name), /api/sync/status generically, and empty overrides/notes/events:
 * Weight issues the same three annotation requests every other page does through useAnnotations,
 * and none of this file's tests need a real row on any of them.
 */
function stubWeight(series: Record<string, SeriesPoint[]>, urls: string[] = []): () => void {
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
      for (const metric of metrics) body[metric] = { points: series[metric] ?? [], reduction: null }
      return json(body)
    }
    if (url.includes('/overrides')) return json({ items: [] })
    if (url.includes('/notes')) return json({ items: [] })
    if (url.includes('/events')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Mounts <Weight /> for real against `series` and waits for every query to settle. The default
 * route is the week holding 2026-08-10 through 2026-08-16, wide enough that a fixture carrying
 * only 2026-08-14 leaves 2026-08-15 (among others) as a day nothing answered, which is what the
 * episodic filter test below needs; a caller naming its own `route` overrides it.
 */
async function mount(
  node: ReactNode, series: Record<string, SeriesPoint[]>,
  route = '/weight?range=week&on=2026-08-14', urls: string[] = [],
): Promise<void> {
  const restore = stubWeight(series, urls)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  window.history.replaceState(null, '', route)
  act(() => {
    root!.render(<I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>)
  })
  await flush(client, () => container!.innerHTML)
  restore()
}

describe('the Weight page', () => {
  // The trap this page exists to get right: METRICS.weight.precision is declared in grams, the
  // stored unit, and this card displays kilograms. formatMetricValue('weight') would read that
  // precision straight off the catalogue and print "81200.0"; getting it right means never calling
  // it here at all.
  //
  // <td>81.2</td>, not a substring match: precision breaking to 81.20 or a missed conversion to
  // 81200.0 would both still contain "81.2" as a fragment, exactly the gap Task 3's own report
  // named for this same idiom.
  it('shows weight in kilograms at one decimal, not the stored grams', async () => {
    await mount(<Weight />, { weight: [seriesPoint('weight', '2026-08-14', 81_200)] })
    const html = container!.innerHTML
    expect(html).toContain('<td>81.2</td>')
    expect(html).not.toContain('81200')
  })

  // The second consequence the brief calls out: the card's headline is not the chart's own table
  // cell, so it converts separately, through formatNumber rather than formatMetricValue, same as
  // the table but a different call site. A headline that skipped this would print "81,200.0 kg".
  it('shows the headline figure in kilograms too, converted separately from the table', async () => {
    await mount(<Weight />, { weight: [seriesPoint('weight', '2026-08-14', 81_200)] })
    const value = [...container!.querySelectorAll('.card')]
      .find((card) => card.querySelector('.label')?.textContent === 'Weight')
      ?.querySelector('.value')
    expect(value?.textContent).toBe('81.2 kg')
  })

  // Sparkline's own episodic filter (Sparkline.tsx): a silent day, one nothing answered and the
  // reader did nothing to, is not a row this table states anything about. The range spans
  // 2026-08-10 through 2026-08-16; only 2026-08-14 carries a reading, so every other day, 08-15
  // included, must be absent from the accessible table rather than rowed as "no reading".
  it('lists only the days that carry a reading', async () => {
    await mount(<Weight />, { weight: [seriesPoint('weight', '2026-08-14', 81_200)] })
    const table = container!.innerHTML.match(/<table class="sr-only">[\s\S]*?<\/table>/)?.[0]
    if (!table) throw new Error('no accessible table rendered')
    expect(table).toContain('2026-08-14')
    expect(table).not.toContain('2026-08-15')
  })

  // body_fat is a percent and is never converted: it takes the default path (formatMetricValue),
  // reading its own precision (1, packages/core/src/derive/metrics.ts's SPOT) straight off the
  // catalogue rather than through a call site that would need to know to skip the weight card's
  // own conversion.
  it('renders body fat as a plain percent, through the catalogue precision, not converted', async () => {
    await mount(<Weight />, { body_fat: [seriesPoint('body_fat', '2026-08-14', 22.34)] })
    const html = container!.innerHTML
    expect(html).toContain('<td>22.3</td>')
  })

  // Both cards share an agg, so the page costs one round trip, the same property every sibling
  // page's own version of this test pins rather than a literal request count.
  it('asks for its two metrics in one request, at agg last', async () => {
    const urls: string[] = []
    await mount(<Weight />, {}, undefined, urls)
    const series = urls.filter((u) => u.includes('/series') && u.includes('agg=last'))
    expect(series).toHaveLength(1)
    expect(series[0]!.match(/metric=/g)).toHaveLength(2)
  })
})
