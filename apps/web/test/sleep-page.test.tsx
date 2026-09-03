// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Sleep } from '../src/pages/Sleep.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { Insight } from '../src/data/useInsight.js'
import { flush, pumpUntil } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// Sparkline draws for real here, and echarts.init's effect throws "missing chart token" without
// this, the same reason activity.test.tsx and recovery.test.tsx need it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/sleep')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  // A safety net rather than the primary reset: the clock test below restores real timers itself,
  // but an assertion failure there would otherwise leak a mocked clock into whatever test runs next.
  vi.useRealTimers()
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
 * Answers every route Sleep calls: the session, /series for whichever metrics land in each of the
 * three groups, /api/sync/status (the control row's own query, answered generically by the
 * fallback below) and /baselines for sleep_asleep_minutes' own baseline. Every sleep metric is
 * handed 420 (7h 00m), not the 60 Activity.tsx and Recovery.tsx use for their own metrics: 420
 * both reads as a plausible night's sleep, unlike 60, and is the same value regardless of which
 * of this page's cards compute a mean and which compute a sum, since every stubbed metric here
 * carries exactly one point.
 *
 * Rows are built by metricCoverage.ts's seriesPoint rather than written as literals here, so the
 * coverage comes off the same table every other stub reads and no field can quietly go missing.
 * Every sleep metric answers null there, because packages/core/src/derive/sleep.ts writes coverage
 * null for every sleep row on purpose (a night has no samples underneath it), and a stub that could
 * not express that shape is the exact gap that let a null coverage render as "device not worn"
 * over a fully populated month through thirteen task reviews.
 */
// A fixed night for the hypnogram card, independent of whatever the schedule override below asks
// for: the two cards read different sources since the schedule fix (sleep_bedtime_minutes/
// sleep_waketime_minutes, not /sleep/nights, see Sleep.tsx's own scheduleNights comment for why),
// and the hypnogram has no reason to change shape from test to test.
const HYPNOGRAM_NIGHT_DATE = '2026-08-15'
const NIGHT_MIDNIGHT = Date.parse(`${HYPNOGRAM_NIGHT_DATE}T00:00:00Z`)
// The route's own `naps` field: nap start instants, outside startMs..endMs by construction, since
// readSleepNights puts in the span only what assembleNights kept as the night. Empty by default,
// which is the shape every test here but the naps column one wants.
function hypnogramNightsResponse(naps: number[] = []): unknown {
  const startMs = NIGHT_MIDNIGHT - 40 * 60_000 // 23:20 the day before
  const endMs = NIGHT_MIDNIGHT + 425 * 60_000 // 07:05
  return {
    items: [{
      localDate: HYPNOGRAM_NIGHT_DATE, sourceId: 'watch', sessionIds: ['s1'],
      startMs, endMs, startOffsetMinutes: 0, endOffsetMinutes: 0, naps,
      segments: [{ stage: 'LIGHT', startMs, endMs }],
    }],
    cursor: null,
  }
}

/**
 * Answers every route Sleep calls: the session, /series for whichever metrics land in each of the
 * three groups, /sleep/nights (the hypnogram card's own fixed night, see above), /api/sync/status
 * (the control row's own query, answered generically by the fallback below) and /baselines for
 * sleep_asleep_minutes' own baseline. Every sleep metric is handed 420 (7h 00m), not the 60
 * Activity.tsx and Recovery.tsx use for their own metrics: 420 both reads as a plausible night's
 * sleep, unlike 60, and is the same value regardless of which of this page's cards compute a mean
 * and which compute a sum, since every stubbed metric here carries exactly one point.
 *
 * `schedule` overrides sleep_bedtime_minutes/sleep_waketime_minutes specifically, in the exact
 * convention those two metrics carry on the wire (minutes from local midnight, negative before
 * it; packages/core/src/derive/metrics.ts's own "an 23:30 bedtime is -30"), because that pair, not
 * /sleep/nights, is what the sleep schedule card draws since the contamination fix (see Sleep.tsx's
 * own scheduleNights comment). Defaults to the same 23:20 to 07:05 night the hypnogram gets
 * (bedtime -40, waketime 425), so every other test in this file, which does not care about the
 * schedule chart specifically, still gets a real night rather than tripping the empty state (see
 * the ".empty" assertion below).
 *
 * Rows are built by metricCoverage.ts's seriesPoint rather than written as literals here, so the
 * coverage comes off the same table every other stub reads and no field can quietly go missing.
 * Every sleep metric answers null there, because packages/core/src/derive/sleep.ts writes coverage
 * null for every sleep row on purpose (a night has no samples underneath it), and a stub that could
 * not express that shape is the exact gap that let a null coverage render as "device not worn"
 * over a fully populated month through thirteen task reviews.
 *
 * `insightOverrides` feeds metricCoverage.ts's own insightBody, unset by default: a caller that
 * does not care what the insight card shows gets a real, unsuppressed period back rather than an
 * empty `{}` (which InsightCard's own `== null` guard reads as "not enough data"), the same
 * default insightBody itself takes. Folded into this one general purpose stub, not a second
 * function, because leaving /insights unanswered here is what turned the asleep insight card into
 * an empty state under every test already written against this stub, including the one below that
 * asserts no card renders one at all.
 */
type BaselineStub = { center: number, spread: number, n: number, thin: boolean } | null

function stubSleep(
  urls: string[], schedule: { bedtimeMinutes: number, waketimeMinutes: number } = { bedtimeMinutes: -40, waketimeMinutes: 425 },
  // Leaves /baselines in flight forever rather than answering it, for the one test that reads the
  // asleep card's basis while that request has not settled. A never resolving promise makes that a
  // resting state instead of a moment in a sequence, so nothing here has to race a delay.
  hangBaselines = false,
  insightOverrides: Partial<Insight> = {},
  // Added at the end, defaulted to null, rather than inserted before insightOverrides: several
  // call sites already pass insightOverrides positionally, and a param inserted ahead of it would
  // have silently reinterpreted every one of those as this one instead.
  baseline: BaselineStub = null,
  // The nights row's own naps, for the schedule card's naps column. Appended at the end for the
  // same reason `baseline` above was: several call sites already pass the earlier parameters
  // positionally.
  naps: number[] = [],
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
      for (const metric of metrics) {
        const value = metric === 'sleep_bedtime_minutes' ? schedule.bedtimeMinutes
          : metric === 'sleep_waketime_minutes' ? schedule.waketimeMinutes
          : 420
        body[metric] = {
          points: [seriesPoint(metric, '2026-08-15', value)],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/sleep/nights')) return json(hypnogramNightsResponse(naps))
    if (url.includes('/baselines')) {
      return hangBaselines ? new Promise<Response>(() => {}) : json({ baseline })
    }
    if (url.includes('/insights')) return json(insightBody(url, insightOverrides))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Four nights per metric rather than stubSleep's one, so trend() has two halves to compare and the
 * tiles' deltas actually render: with a single point it divides a one element slice against
 * nothing and returns undefined, which is why no test in this file had ever seen a delta at all.
 *
 * The bedtime pair is 23:58 twice then 23:30 twice, in sleep_bedtime_minutes' own convention
 * (minutes from the wake day's midnight, negative before it), which is a person going to bed
 * earlier; the wake pair is 06:00 twice then 07:30 twice. Every other metric moves 400 to 440, a
 * plain ten percent on a scale where a percentage means something.
 */
function stubSleepTrend(): () => void {
  const original = globalThis.fetch
  const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15']
  const seriesFor = (metric: string): number[] => {
    if (metric === 'sleep_bedtime_minutes') return [-2, -2, -30, -30]
    if (metric === 'sleep_waketime_minutes') return [360, 360, 450, 450]
    return [400, 400, 440, 440]
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      return json(Object.fromEntries(metrics.map((metric) => [metric, {
        points: seriesFor(metric).map((value, index) => seriesPoint(metric, DATES[index]!, value)),
        reduction: null,
      }])))
    }
    if (url.includes('/sleep/nights')) return json(hypnogramNightsResponse())
    if (url.includes('/baselines')) return json({ baseline: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Every metric gets stubSleep's usual 420 except sleep_nap_count, which gets `napCount` on its
 * own single day. napCount sums the same way sleep_nap_count's own card does (Sleep.tsx's
 * `napCountTotal`), so a stubbed value of 1 is the total the basis line pluralises on, not one
 * of several days averaged away.
 */
function stubSleepNapCount(napCount: number): () => void {
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
        const value = metric === 'sleep_nap_count' ? napCount : 420
        body[metric] = {
          points: [seriesPoint(metric, '2026-08-15', value)],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Every metric gets stubSleep's usual 420 except sleep_efficiency, which gets `efficiency` on its
 * own single day. Used by the precision test below: sleep_efficiency's card used to hardcode
 * `.toFixed(0)` rather than reading METRICS.sleep_efficiency.precision (0) through
 * formatMetricValue, and an unrounded mean is what tells the two apart.
 */
function stubSleepEfficiency(efficiency: number): () => void {
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
        const value = metric === 'sleep_efficiency' ? efficiency : 420
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', value)], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * `/sleep/nights` with a single night carrying exactly the `segments` handed in, at real
 * millisecond instants (not `hypnogramNightsResponse`'s own fixed one-segment night), for the
 * review round 1 regression test below: that test needs boundaries on the provider's actual 30
 * second grid, which `hypnogramNightsResponse` has no parameter for. Every other route answers
 * the same way `stubSleep`'s own default does (420 per metric, no baseline).
 */
function stubSleepHalfMinuteBoundaries(segments: { sessionId: string, stage: string, startMs: number, endMs: number }[]): () => void {
  const original = globalThis.fetch
  const nightStartMs = NIGHT_MIDNIGHT - 40 * 60_000
  const nightEndMs = segments.at(-1)?.endMs ?? nightStartMs
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      return json(Object.fromEntries(
        metrics.map((metric) => [metric, { points: [seriesPoint(metric, '2026-08-15', 420)], reduction: null }]),
      ))
    }
    if (url.includes('/sleep/nights')) {
      return json({
        items: [{
          localDate: HYPNOGRAM_NIGHT_DATE, sourceId: 'watch', sessionIds: ['s1'],
          startMs: nightStartMs, endMs: nightEndMs, startOffsetMinutes: 0, endOffsetMinutes: 0, naps: [],
          segments,
        }],
        cursor: null,
      })
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Sleep page', () => {
  // The shape that produced M3d-1's Critical: sleep rows carry a null coverage because a night
  // has no samples underneath it, and reading that as zero rendered "device not worn" over a
  // fully populated month.
  it('draws a populated month rather than calling the device unworn', async () => {
    const restore = stubSleep([])
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    // A structural marker, not the raw key: this test does not wrap I18nProvider, so an
    // untranslated t() happens to hand back the key literally today, which made the original
    // assertion pass for the right reason here but for the wrong one, since it would keep passing
    // even against real, resolved English text ("Device not worn" is not the string
    // "emptyState.not_worn.title" either). EmptyState is the one component that renders
    // className="empty" (components/EmptyState.tsx), for any of the three kinds MetricCard can
    // pick, so its absence is the actual claim this test makes: no card fell back to an empty
    // state at all, not-worn or otherwise.
    expect(container!.querySelector('.empty')).toBeNull()
    expect(container!.textContent).toContain('7h 00m')
    restore()
  })

  it('does not import the fixtures', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('apps/web/src/pages/Sleep.tsx', 'utf8')
    expect(source).not.toContain('fixtures/july')
  })

  // M3d-1 left this page with a working Sync button beside range buttons that did nothing, and a
  // hardcoded "Synced 12 min ago" on an instance that may have synced seconds ago.
  it('drives the control row from the URL rather than a stub', async () => {
    const restore = stubSleep([])
    window.history.replaceState(null, '', '/sleep?range=week&on=2026-08-15')
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const pressed = [...container!.querySelectorAll('.segment')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.textContent).toContain('controlRow.ranges.week')
    restore()
  })

  // Only three requests regardless of eleven cards: /series takes one agg per call, and this page
  // groups its metrics into sum, last and count, the same REQUESTS/under('agg') shape Recovery.tsx
  // and Activity.tsx already use.
  it('batches by agg, so the request count is the number of distinct aggs', async () => {
    const urls: string[] = []
    const restore = stubSleep(urls)
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    const aggs = new Set(series.map((u) => new URLSearchParams(u.split('?')[1] ?? '').get('agg')))
    expect(series).toHaveLength(aggs.size)
    expect(aggs).toEqual(new Set(['sum', 'last', 'count']))
    restore()
  })

  // The axis change this task is for, corrected in review: a sixteen hour night (20:00 to 12:00)
  // turned out to clear the DEFAULT noon-to-noon window too once the schedule math itself was
  // fixed (see schedule.test.ts's own "sixteen hour night" case), so it no longer demonstrates the
  // wider window earning its keep. A night running past the wide window's own far noon does: 20:00
  // to 22:00 the next day is 26 hours, which the default window (top at 2160, noon the next day)
  // cannot hold (bed lands at 1200, wake at 2760) but the wide one (top at 2880) can. Asserted
  // against the accessible table, never the canvas: happy-dom applies no stylesheet and echarts
  // draws to canvas, so no test here can see a span.
  it('draws a night running past the default window rather than suppressing it as no data', async () => {
    const restore = stubSleep([], { bedtimeMinutes: -4 * 60, waketimeMinutes: 22 * 60 })
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const tables = [...container!.querySelectorAll('table.sr-only')]
    const scheduleTable = tables.find((table) => table.textContent?.includes('22:00'))
    expect(scheduleTable, tables.map((t) => t.textContent).join('\n---\n')).toBeDefined()
    expect(scheduleTable!.textContent).not.toContain('charts.absence.noReading')
    restore()
  })

  // A new column rather than a changed value: SleepSchedule has drawn naps as a scatter series
  // with its own table column since it was written, and this card passed showNaps=false because
  // none of the metrics it reads knows when a nap started (sleep_nap_count and sleep_nap_minutes
  // are a count and a duration). /sleep/nights knows, now that readSleepNights splits each date
  // into the night and what did not join it, so the column appears and carries the nap's own
  // clock time. 14:30 is 870 minutes past the wake day's midnight, which the wide window (noon to
  // noon two days on) places unshifted.
  it('fills the schedule naps column from /sleep/nights, rather than claiming none', async () => {
    const restore = stubSleep([], undefined, false, {}, null, [NIGHT_MIDNIGHT + 870 * 60_000])
    const { client, tree } = withQuery(<Sleep />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const tables = [...container!.querySelectorAll('table.sr-only')]
    const scheduleTable = tables.find((table) => table.textContent?.includes('charts.columns.naps'))
    expect(scheduleTable, tables.map((t) => t.textContent).join(' | ')).toBeDefined()
    expect(scheduleTable!.textContent).toContain('14:30')
    expect(scheduleTable!.textContent).not.toContain('charts.absence.none')
    restore()
  })

  // Review round 1's own Critical: hypnogramSegments used to round each boundary
  // (Math.round((s.startMs - lastNight.startMs) / 60_000)) to a whole minute before handing it to
  // Hypnogram, which then summed those already-rounded boundaries for the totals row. The
  // provider reports sleep on a 30 second grid, so every boundary offset here is an exact multiple
  // of half a minute, and JS's Math.round never rounds a positive .5 down, so the old rounding was
  // a deterministic bias rather than noise that could cancel across a night.
  //
  // Ten 90 second segments, alternating LIGHT/DEEP: true total per stage is 5 * 1.5 = 7.5 minutes,
  // which a single rounding takes to 8. The old boundary-rounding read LIGHT as 10m and DEEP as 5m
  // instead, worked by hand from the rounded boundaries 0,2,3,5,6,8,9,11,12,14,15 (minutes from
  // night start): LIGHT's five segments 0-2, 3-5, 6-8, 9-11, 12-14 sum to 10; DEEP's five 2-3,
  // 5-6, 8-9, 11-12, 14-15 sum to 5. Run against the pre-fix Sleep.tsx and Hypnogram.tsx (the
  // version committed in 71cc06a), this test fails: the totals row read "Light 0h 10m, Deep 0h
  // 05m" rather than "Deep 0h 08m, Light 0h 08m". See task-5-report.md's fix section for that
  // output.
  it('totals a night built from half minute segment boundaries to its true duration, not one inflated by rounding each boundary first', async () => {
    const nightStartMs = NIGHT_MIDNIGHT - 40 * 60_000
    const boundaries = Array.from({ length: 11 }, (_, i) => nightStartMs + i * 90_000)
    const segments = boundaries.slice(0, -1).map((startMs, i) => ({
      sessionId: 's1', stage: i % 2 === 0 ? 'LIGHT' : 'DEEP', startMs, endMs: boundaries[i + 1]!,
    }))
    const restore = stubSleepHalfMinuteBoundaries(segments)
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    // Scoped to the totals row itself, not the whole page: the accessible table right above it
    // legitimately prints "0h 05m" and "0h 10m" as segment boundary times (a "to" cell reads the
    // clock offset a segment ended at, not a summed duration), so asserting against the page's
    // whole text would flag those true, unrelated cells as if they were the totals row's own bug.
    const totalsRow = container!.querySelector('.hypnogram-totals')
    expect(totalsRow, container!.innerHTML).not.toBeNull()
    expect(totalsRow!.textContent).toBe('Deep 0h 08m, Light 0h 08m')
    restore()
  })

  // The other half of the shared sleep.stage keys this page reuses from the fixture era Sleep.tsx
  // (deep/light/rem/awake stage names), now carried by the deep/light/rem/awake minute cards
  // rather than a hypnogram legend: pages.test.tsx used to pin this against that legend, which
  // this task removes along with the rest of the fixture backed chart it belonged to, so the claim
  // that stage names go through the shared keys and not a second, English-only set moves here.
  it('translates sleep stage names through the shared sleep.stage keys, not a second set', async () => {
    const restore = stubSleep([])
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('Diep')
    expect(container!.innerHTML).not.toContain('>Deep<')
    restore()
  })

  // Every other test in this file stubs sleep_nap_count at 420, so only sleep.napCount.basis_other
  // ever renders and the singular half the brief asked for (basis_one, {{count}} nap rather than
  // naps) has never actually been exercised. Confirming it is reachable is the point, not merely
  // that the plural is: i18next only reaches _one when the interpolated count is really 1, so a
  // stub that always hands over a bigger number could hide a catalogue typo in the singular form
  // forever.
  it('reaches the singular nap count form, not only the plural every other stub hits', async () => {
    const restore = stubSleepNapCount(1)
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('1 nap,')
    expect(container!.textContent).not.toContain('1 naps,')
    restore()
  })

  it('picks the Dutch singular nap count too', async () => {
    const restore = stubSleepNapCount(1)
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('1 dutje,')
    expect(container!.textContent).not.toContain('1 dutjes,')
    restore()
  })

  // The refactor this task is for: sleep_efficiency's card used to hardcode
  // `efficiencyMean.toFixed(0)`, which happened to match METRICS.sleep_efficiency.precision (0)
  // by coincidence rather than by reading it.
  //
  // toBe, not toContain: "88" is a substring of "88.0" too, which a dropped
  // minimumFractionDigits/maximumFractionDigits pin would still render. Confirmed by reverting the
  // formatMetricValue call back to `efficiencyMean.toFixed(2)`: this failed with
  // "Received: 87.60 %" where it expects "88 %". Placed after the tests above that already mount
  // an I18nProvider, not before 'drives the control row from the URL rather than a stub': that
  // test's own assertion depends on no I18nProvider having been mounted yet in this file (see
  // dashboard-cards.test.tsx's matching comment on the same hazard), and this test needs one to
  // resolve real labels.
  it('rounds sleep efficiency to its own catalogue precision, not a copied-in literal', async () => {
    const restore = stubSleepEfficiency(87.6)
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Sleep efficiency')
    expect(card?.querySelector('.value')?.textContent).toBe('88 %')
    restore()
  })

  // trend() is a percentage change between the period's two halves, which needs a scale where a
  // ratio means something. sleep_bedtime_minutes is a clock offset from the wake day's midnight,
  // negative before it, so a fortnight averaging 23:58 against one averaging 23:30 is a person
  // going to bed half an hour earlier and came out of the tile as an up arrow reading 1400%.
  // sleep_waketime_minutes shares the scale and is less absurd only by accident of sign.
  //
  // Every other stub in this file hands one point per metric, which makes trend() return undefined
  // outright, so no test here could see the delta at all. This one hands four, and asserts a
  // sibling tile on the same page still shows its delta: without that half, a page that had simply
  // stopped rendering deltas anywhere would pass.
  it('states no percentage change over a bedtime or a wake time, which are clock offsets', async () => {
    const restore = stubSleepTrend()
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const cardFor = (label: string) => [...container!.querySelectorAll('.card')]
      .find((card) => card.querySelector('.label')?.textContent === label)
    for (const label of ['Bedtime', 'Wake time']) {
      const card = cardFor(label)
      expect(card, label).toBeDefined()
      expect(card!.querySelector('.delta'), label).toBeNull()
    }
    expect(cardFor('Deep')!.querySelector('.delta')).not.toBeNull()
    restore()
  })

  // A rendered state, not a theoretical one. MetricCard gates on the series query and /baselines is
  // a separate request, so the asleep card draws while the baseline is still in flight; baselineNote
  // read `data?.baseline ?? null` straight after its error test, so undefined took the null branch
  // and the card stated "no baseline yet to compare against" before anything had been asked.
  it('does not claim there is no baseline while the baseline request is in flight', async () => {
    const restore = stubSleep([], { bedtimeMinutes: -40, waketimeMinutes: 425 }, true)
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // The card's own basis paragraph, not just its label: a label can render in the pending
    // branch (Dashboard's copy of this test proves it), and only a basis says the card is past
    // it. Scoped to the card under test so a sibling settling first cannot answer for it.
    await pumpUntil(
      () => [...container!.querySelectorAll('.card')].some((card) =>
        card.querySelector('.label')?.textContent === 'Time asleep' && card.querySelector('.basis') !== null),
      'the time asleep basis line',
    )
    const text = container!.textContent!
    expect(text).toContain('the baseline is still loading')
    expect(text).not.toContain('no baseline yet to compare against')
    restore()
  })

  // M3 phase review B2: asleepBaseline itself moved to historicalTo, but baselineNote's own `on`
  // argument, which only reaches the rendered text through the thin branch
  // (sleep.baselineNote.thin interpolates {{on}}; the other branches do not), kept reading
  // controls.to. Dashboard.tsx's own hrBaseline comment states the invariant this reopened for
  // Sleep: the note has to name the date the band was really computed against.
  it('names the baseline\'s own anchor date in a thin note, not the month\'s own future end', async () => {
    vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
    window.history.replaceState(null, '', '/sleep?range=month')
    const restore = stubSleep(
      [], { bedtimeMinutes: -40, waketimeMinutes: 425 }, false, {}, { center: 420, spread: 30, n: 10, thin: true },
    )
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const text = container!.textContent!
    expect(text).toContain('60 nights before 2026-09-05')
    expect(text).not.toContain('60 nights before 2026-09-30')
    restore()
    vi.useRealTimers()
  })

  // Task 4's own insight card. formatSignedDuration (format.ts), passed straight as this card's
  // formatValue, routes insight.current/previous/delta through formatDuration, the same call the
  // time asleep tile's own headline makes a few cards up, so the card reads "1h 10m" beside it
  // rather than a bare, unitless "70". range=month&on=2026-08-15 gives clean, hand-computable
  // calendar-month windows, the same fixed date dashboard-cards.test.tsx uses for its own copy of
  // this assertion.
  it('formats the sleep insight as a duration rather than raw minutes', async () => {
    window.history.replaceState(null, '', '/sleep?range=month&on=2026-08-15')
    const restore = stubSleep([])
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Time asleep, this period against the last')
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '1h 10m on average (Aug 1, 2026 to Aug 31, 2026) against 1h 00m on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 0h 10m.',
    )
    restore()
  })

  // The sign bug Task 3's own review round found on Dashboard's identically shaped card:
  // formatDuration was only ever fed a non-negative duration before insight cards existed, and its
  // own Math.floor(total / 60) paired with a sign-carrying total % 60 prints a negative input as
  // two minus signs ("-1h -7m") rather than one on the whole duration. -7 alone (a seven minute
  // drop, not a large or hour-crossing one) is enough to show it.
  it('formats a negative sleep insight delta with one leading minus rather than two', async () => {
    window.history.replaceState(null, '', '/sleep?range=month&on=2026-08-15')
    const restore = stubSleep([], undefined, false, { current: 401, previous: 408, delta: -7 })
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Time asleep, this period against the last')
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '6h 41m on average (Aug 1, 2026 to Aug 31, 2026) against 6h 48m on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of -0h 07m.',
    )
    restore()
  })

  // Suppression, exercised with a null current rather than the suppressed flag alone: this pins
  // the hazard note's own "vary your fixtures" example (a null field), and confirms the card falls
  // back to the safe empty state rather than reaching formatDuration with a null it cannot handle.
  it('falls back to the insufficient message when the server suppresses the sleep insight', async () => {
    const restore = stubSleep([], undefined, false, { suppressed: true, reason: 'thin-days', current: null, previous: null, delta: null })
    const { client, tree } = withQuery(<Sleep />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Time asleep, this period against the last')
    expect(card?.textContent).toContain('too few days')
    expect(card?.querySelector('.insight-summary')).toBeNull()
    restore()
  })
})
