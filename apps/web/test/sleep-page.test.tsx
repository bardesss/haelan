// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
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
import { flush, pumpUntil } from './flush.js'
import { coverageFor } from './metricCoverage.js'

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
 * coverageFor is read off metricCoverage.ts rather than written as a literal here: every sleep
 * metric there answers null, because packages/core/src/derive/sleep.ts writes coverage null for
 * every sleep row on purpose (a night has no samples underneath it), and a stub that could not
 * express that shape is the exact gap that let a null coverage render as "device not worn" over a
 * fully populated month through thirteen task reviews.
 */
// A fixed night for the hypnogram card, independent of whatever the schedule override below asks
// for: the two cards read different sources since the schedule fix (sleep_bedtime_minutes/
// sleep_waketime_minutes, not /sleep/nights, see Sleep.tsx's own scheduleNights comment for why),
// and the hypnogram has no reason to change shape from test to test.
const HYPNOGRAM_NIGHT_DATE = '2026-08-15'
function hypnogramNightsResponse(): unknown {
  const wakeMidnight = Date.parse(`${HYPNOGRAM_NIGHT_DATE}T00:00:00Z`)
  const startMs = wakeMidnight - 40 * 60_000 // 23:20 the day before
  const endMs = wakeMidnight + 425 * 60_000 // 07:05
  return {
    items: [{
      localDate: HYPNOGRAM_NIGHT_DATE, sourceId: 'watch', sessionIds: ['s1'],
      startMs, endMs, startOffsetMinutes: 0, endOffsetMinutes: 0,
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
 * coverageFor is read off metricCoverage.ts rather than written as a literal here: every sleep
 * metric there answers null, because packages/core/src/derive/sleep.ts writes coverage null for
 * every sleep row on purpose (a night has no samples underneath it), and a stub that could not
 * express that shape is the exact gap that let a null coverage render as "device not worn" over a
 * fully populated month through thirteen task reviews.
 */
function stubSleep(
  urls: string[], schedule: { bedtimeMinutes: number, waketimeMinutes: number } = { bedtimeMinutes: -40, waketimeMinutes: 425 },
  // Leaves /baselines in flight forever rather than answering it, for the one test that reads the
  // asleep card's basis while that request has not settled. A never resolving promise makes that a
  // resting state instead of a moment in a sequence, so nothing here has to race a delay.
  hangBaselines = false,
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
          points: [{ localDate: '2026-08-15', value, coverage: coverageFor(metric), sourceMix: null }],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/sleep/nights')) return json(hypnogramNightsResponse())
    if (url.includes('/baselines')) {
      return hangBaselines ? new Promise<Response>(() => {}) : json({ baseline: null })
    }
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
        points: seriesFor(metric).map((value, index) => ({
          localDate: DATES[index], value, coverage: coverageFor(metric),
          source: 'merged', sourceMix: null, updatedAtMs: 1_755_000_000_000,
        })),
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
        body[metric] = { points: [{ localDate: '2026-08-15', value, coverage: coverageFor(metric), sourceMix: null }], reduction: null }
      }
      return json(body)
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
    await pumpUntil(() => container!.textContent!.includes('Time asleep'), 'the time asleep card')
    const text = container!.textContent!
    expect(text).toContain('the baseline is still loading')
    expect(text).not.toContain('no baseline yet to compare against')
    restore()
  })
})
