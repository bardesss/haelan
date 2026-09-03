// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { dayMetricTarget } from '@haelan/core/target-key'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { SeriesPoint } from '../src/data/useSeries.js'
import type { StoredOverride } from '../src/data/useAnnotations.js'
import { Weight } from '../src/pages/Weight.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { Insight } from '../src/data/useInsight.js'
import { flush } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

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
 * `series`, keyed by metric name), /api/sync/status generically, and notes/events empty:
 * Weight issues the same three annotation requests every other page does through useAnnotations,
 * and none of this file's tests need a real row on notes or events. /overrides defaults to empty
 * too, and `overrides` is the one seam a caller can fill: what deriveDay actually leaves behind
 * once an exclusion has applied is an override row that outlives the /series row it excluded (see
 * the episodic exclusion test below), so a fixed empty list here would make that shape unreachable.
 */
/**
 * insightOverrides feeds metricCoverage.ts's own insightBody, unset by default: a caller that
 * does not care what the insight card shows gets a real, unsuppressed period back rather than a
 * fixed shape of its own, the same default insightBody itself takes.
 */
function stubWeight(
  series: Record<string, SeriesPoint[]>, urls: string[] = [], overrides: readonly StoredOverride[] = [],
  insightOverrides: Partial<Insight> = {},
): () => void {
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
    if (url.includes('/overrides')) return json({ items: overrides })
    if (url.includes('/notes')) return json({ items: [] })
    if (url.includes('/events')) return json({ items: [] })
    if (url.includes('/insights')) return json(insightBody(url, insightOverrides))
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
  route = '/weight?range=week&on=2026-08-14', urls: string[] = [], overrides: readonly StoredOverride[] = [],
  insightOverrides: Partial<Insight> = {},
): Promise<void> {
  const restore = stubWeight(series, urls, overrides, insightOverrides)
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

  // The whole-branch review's own finding: the test above pins the episodic filter with an empty
  // /overrides every time, so it only ever exercises the SILENT half of Sparkline's own filter (a
  // day nothing answered). The other half, an EXCLUDED day, runs through a different chain on this
  // page: overridesByMetric groups the /overrides row, annotationsFor reads it back out for
  // 'weight', and the sparkFormat closure in Weight.tsx's own `card()` turns the day's null value
  // into the word "excluded" rather than a fabricated number. chart-marks.test.tsx already pins
  // Sparkline's own half of this with hand-built props; nothing before this test exercised the
  // page's own wiring into it, which is exactly the shape M3c's blocker survived in (an applied
  // exclusion vanishing from the accessible table while the canvas still drew its mark).
  //
  // What deriveDay actually leaves behind once an exclusion has applied: the excluded metric's own
  // day row is gone from /series (dashboard-cards.test.tsx's own stubAppliedExclusion carries the
  // identical shape for Dashboard's steps card), and only GET /overrides still names the day, so
  // that is what this fixture reproduces rather than a shape this page would never actually see.
  it('keeps an excluded weight day in the table with its reason, once the exclusion has applied', async () => {
    const overrides: StoredOverride[] = [{
      id: 'o1', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-08-15', metric: 'weight' }),
      action: 'exclude', correctedValue: null, reason: 'scale was wrong',
    }]
    await mount(<Weight />, { weight: [seriesPoint('weight', '2026-08-14', 81_200)] }, undefined, [], overrides)
    const table = container!.innerHTML.match(/<table class="sr-only">[\s\S]*?<\/table>/)?.[0]
    if (!table) throw new Error('no accessible table rendered')
    expect(table).toContain('2026-08-14')
    const row = table.slice(table.indexOf('2026-08-15'), table.indexOf('2026-08-15') + 200)
    // The value cell reads the absence word outright, `<td>excluded</td>`, never a fabricated
    // number: /series is silent for this day (deriveDay deleted its row), so any number here would
    // be this test's own fixture leaking through rather than what the page actually renders.
    expect(row).toContain('<td>excluded</td>')
    expect(row).toContain('excluded, scale was wrong')
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

  // Task 4's own trap, restated for the insight card: METRICS.weight.precision is 1, declared in
  // grams, and this card displays kilograms, so it must never reach formatMetricValue (which
  // would read the stored unit's precision against an already converted number and print
  // "81,200.0 kg"). The card's own formatValue converts and formats through formatNumber with its
  // own precision instead, the same conversion the headline above already makes.
  //
  // not.toContain('81,200'), not a bare '81200': the wrong path's own output groups thousands
  // ("81,200.0 kg", toLocaleString's own comma), so a check for the ungrouped digit string would
  // never actually appear in either path's output and would pass whether the conversion was right
  // or wrong -- exactly the kind of assertion that never fires. Confirmed by hand: swapping
  // weightInsightFormat in Weight.tsx for `(v, absent) => formatMetricValue(v, 'weight', ...)`
  // failed this test with "Received: 81,200.0 kg on average ..." where it expects to contain
  // "81.2 kg", then reverted.
  it('shows the weight insight in kilograms, not the stored grams', async () => {
    await mount(<Weight />, {}, undefined, [], [], { current: 81_234.5, previous: 81_469.0, delta: -234.5 })
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Weight, this period against the last')
    const summary = card?.querySelector('.insight-summary')?.textContent
    expect(summary).toContain('81.2 kg')
    expect(summary).toContain('81.5 kg')
    expect(summary).not.toContain('81,200')
  })

  // The whole-branch review's own blocker: the server's guarantee that a reader's own subtraction
  // of the two numbers shown agrees with the delta beside them is computed at gram precision
  // (series.ts), and this card displays kilograms. current and previous round to 81.2 kg and
  // 81.5 kg, a difference of -0.3, but the fixture's own delta (-234.5 g, the server's own correct
  // answer at gram precision) divides naively into -0.2 kg, a number that disagrees with the two
  // figures right beside it. delta is deliberately not current minus previous either (81234.5
  // minus 81469.0 is exactly -234.5, matching the server's own shape at gram precision), so this
  // only catches a broken conversion, not a fixture that disagrees with itself.
  it('derives the weight insight delta from the two displayed kilogram figures, not the stored gram delta', async () => {
    await mount(<Weight />, {}, undefined, [], [], { current: 81_234.5, previous: 81_469.0, delta: -234.5 })
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Weight, this period against the last')
    const summary = card?.querySelector('.insight-summary')?.textContent
    expect(summary).toContain('-0.3 kg')
    expect(summary).not.toContain('-0.2 kg')
  })

  // The other half of the brief's own note: weight will suppress often, and correctly, because a
  // seven day window frequently holds too few of the household's 130 readings across 236 days.
  // Suppressed rather than a guessed number is the feature working, the same emptyState.insufficient
  // copy insight-card.test.tsx already pins for the generic component.
  it('suppresses the weight insight rather than guessing across a thin window', async () => {
    await mount(<Weight />, {}, undefined, [], [], { suppressed: true, reason: 'thin-days' })
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Weight, this period against the last')
    expect(card?.textContent).toContain('too few days')
    expect(card?.querySelector('.insight-summary')).toBeNull()
  })
})
