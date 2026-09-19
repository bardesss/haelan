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
import { Dashboard } from '../src/pages/Dashboard.js'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { NightDetail } from '../src/pages/NightDetail.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { seriesPoint, insightBody } from './metricCoverage.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason dashboard-round-trip.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/dashboard?range=week&on=2026-08-12')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12']

function stubFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] } })
    }
    // A real override (on steps, so the "metric already has annotations" branch of
    // mergeDayAnnotations runs, not only the fallback every other metric takes) plus a real note
    // and a real event, both on the same day: task 11b's own merge has to keep every one of these
    // arrays stable across the rerender below, on both branches, not only on an empty page.
    if (url.includes('/overrides')) {
      return json({
        items: [{
          id: 'o1', scope: 'day_metric',
          targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'steps' }),
          action: 'exclude', correctedValue: null, reason: 'Watch left charging',
        }],
      })
    }
    if (url.includes('/notes')) {
      return json({ items: [{ id: 'n1', localDate: '2026-08-11', body: 'felt off', updatedAtMs: 0 }] })
    }
    if (url.includes('/events')) {
      return json({
        items: [{
          id: 'e1', kind: 'illness', startedAtMs: Date.parse('2026-08-11T09:00:00Z'), startedAtOffsetMinutes: 0,
          endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-11',
        }],
      })
    }
    if (url.includes('/series')) {
      const body: Record<string, unknown> = {}
      for (const metric of new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')) {
        body[metric] = {
          points: DAYS.map((date, i) => seriesPoint(metric, date, 400 + i * 10)),
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/sleep/nights')) {
      const start = Date.parse('2026-08-11T22:00:00Z')
      return json({
        items: [{
          localDate: '2026-08-12', sourceId: 'watch', sessionIds: ['s1'],
          startMs: start, endMs: start + 6 * 3_600_000,
          startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [],
          // Always present on the real route (packages/core/src/query/sleepNights.ts, empty is a
          // measurement); Dashboard.tsx now reads its length unconditionally for the
          // excluded-sessions line, the same field sleep-page.test.tsx's own fixture already sends.
          excludedSessions: [],
          segments: [{ stage: 'DEEP', startMs: start, endMs: start + 6 * 3_600_000 }],
        }],
        cursor: null,
      })
    }
    if (url.includes('/insights')) return json(insightBody(url))
    // Only reached on the Day tab: useSourceNames (IntradayHeartRate's own nameOf) and useIntraday
    // both mount there and nowhere else on this page (Dashboard.tsx gates both on controls.tab).
    if (url.includes('/sources')) {
      return json({
        items: [{
          id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4',
          alias: null, name: 'Pixel Watch 4', kind: 'device', createdAtMs: 0,
        }],
      })
    }
    if (url.includes('/intraday')) {
      return json({
        points: [{ sourceId: 'watch', utcMs: Date.parse('2026-08-12T08:00:00Z'), min: 55, mean: 60, max: 65 }],
        reduction: null,
      })
    }
    return json({ baseline: { center: 60, spread: 4, n: 40, thin: false } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

// A session carrying both a heart rate zone breakdown (WorkoutZones' own ZoneBar) and a PAUSE
// event with a real instant (WorkoutTrace's own eventMarks), so both of the workout page's echarts
// instances actually mount - one from a fresh `zoneRows(...)` call and one from a fresh
// `filter().map()`, if either WorkoutZones.tsx or WorkoutTrace.tsx went back to computing it
// inline on every render.
const WORKOUT_SESSION = {
  id: 'run1', sourceId: 'watch',
  startMs: Date.UTC(2026, 7, 3, 6, 0), endMs: Date.UTC(2026, 7, 3, 6, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: {
    exerciseType: 'RUNNING', displayName: 'Morning run', activeDuration: '3000s',
    metricsSummary: {
      caloriesKcal: 412, distanceMillimeters: 8_000_000,
      heartRateZoneDurations: { lightTime: '600s', peakTime: '120s' },
    },
    exerciseEvents: [{ eventTime: '2026-08-03T06:10:00.000Z', exerciseEventType: 'PAUSE' }],
  },
  excluded: false, excludeReason: null,
}

function stubWorkoutFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sessions/run1')) return json(WORKOUT_SESSION)
    if (url.includes('/intraday/window')) {
      // The pinned read (source=watch, WORKOUT_SESSION's own sourceId) answers real points, so
      // useSourceTrace never needs its all-sources fallback.
      const source = new URLSearchParams(url.split('?')[1] ?? '').get('source') ?? ''
      const points = source === 'watch'
        ? [{ sourceId: 'watch', utcMs: Date.UTC(2026, 7, 3, 6, 10), min: 120, mean: 130, max: 140, n: 1, excluded: false }]
        : []
      return json({ points, reduction: null })
    }
    if (url.includes('/sources')) return json({ items: [] })
    // WorkoutComparison's own useSessions call (a trailing window list, not a third endpoint - its
    // own comment on why).
    if (url.includes('/sessions')) return json({ items: [], cursor: null })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

// A night carrying one staged segment (so NightStages mounts a Hypnogram) and, below, a real
// heart_rate reading pinned to its own source (so NightTraces mounts one IntradayHeartRate) -
// section 4's own two chart-bearing cards, the night page's equivalent of WORKOUT_SESSION's zone
// bar and trace above.
const NIGHT_FIXTURE = {
  localDate: '2026-08-03', sourceId: 'watch', sessionIds: ['s1'],
  startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 3, 5, 2),
  startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [],
  segments: [{ stage: 'DEEP', startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 2, 22, 15) }],
  excludedSessions: [],
}

function stubNightFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sleep/nights')) return json({ items: [NIGHT_FIXTURE], cursor: null })
    if (url.includes('/series')) {
      const body: Record<string, unknown> = {}
      for (const metric of new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')) {
        body[metric] = {
          points: [{ localDate: NIGHT_FIXTURE.localDate, value: 90, coverage: 1, source: 'watch' }],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/intraday/window')) {
      // heart_rate|watch answers real points (one chart); spo2 and hrv, and heart_rate's own
      // all-sources fallback, all answer empty, the same "keyed by <metric>|<source>, an absent
      // source is the empty string" convention night-traces.test.tsx's own stub uses.
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const key = `${params.get('metric') ?? ''}|${params.get('source') ?? ''}`
      const points = key === 'heart_rate|watch'
        ? [{ sourceId: 'watch', utcMs: Date.UTC(2026, 7, 2, 23, 0), min: 48, mean: 52, max: 58, n: 1, excluded: false }]
        : []
      return json({ points, reduction: null })
    }
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Whatever echarts.init rendered into each chart host. dispose() empties the host and a fresh
 * init fills it again, so a chart that survived a render keeps the very same node and one that
 * was torn down and rebuilt does not.
 */
function chartRoots(): (Element | null)[] {
  return [...container!.querySelectorAll('[role="img"]')].map((host) => host.firstElementChild)
}

describe('the charts across a rerender', () => {
  // Section 7 of the spec names "a chart disposed on every render" as one of the two defect
  // classes the render environment was added to catch, and it came back one task later: useChart
  // keys its effect on `build`, every chart's `build` is a useCallback over its data props, and
  // the page handed all five of them freshly constructed arrays on every commit. With eight
  // queries settling at different moments that is roughly eight teardowns and rebuilds of five
  // echarts instances on a single page load.
  //
  // stubFetch above answers a real override, a real note and a real event now (task 11b), so this
  // also exercises mergeDayAnnotations on both of its branches: steps carries an override plus the
  // day level list concatenated onto it, and every other chart on the page falls back to the day
  // level list by reference. A badly memoised merge on either branch (a fresh concat per render, or
  // dayAnnotations rebuilt on a render that changed neither query) would fail this the same way the
  // original defect did.
  it('are not disposed and re-initialised when nothing they draw has changed', async () => {
    const restore = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<Dashboard />)) })
    await flush(client, () => container!.innerHTML)

    const before = chartRoots()
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((node) => node !== null)).toBe(true)

    // A second render of the same component with the same client: every query is already settled
    // and staleTime is Infinity, so nothing the charts draw has changed.
    act(() => { root!.render(tree(<Dashboard />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const after = chartRoots()
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i], `chart ${i} was re-initialised`).toBe(before[i])
    }
    restore()
  })

  // Finding 1 of the m5a source naming branch's final review: useSourceNames handed back a fresh
  // object, and so a fresh `nameOf`, on every render. IntradayHeartRate's own `build` closes over
  // `nameOf` and lists it in that useCallback's deps, and useChart keys its init/dispose effect on
  // `build`, so a stable session and a stable query cache still tore the chart down and rebuilt it
  // on every render -- the case above never caught it because it stays on the week tab, and
  // Dashboard.tsx only mounts IntradayHeartRate on the Day tab.
  it('are not disposed and re-initialised on the Day tab either, where IntradayHeartRate lives', async () => {
    const restore = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', '/dashboard?range=day&on=2026-08-12')
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<Dashboard />)) })
    await flush(client, () => container!.innerHTML)

    const before = chartRoots()
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((node) => node !== null)).toBe(true)

    act(() => { root!.render(tree(<Dashboard />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const after = chartRoots()
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i], `chart ${i} was re-initialised`).toBe(before[i])
    }
    restore()
  })

  // Final review finding on M8b: WorkoutDetail.tsx built `detail` fresh from `workoutDetail(...)`
  // on every render, and WorkoutTrace.tsx's own `marks` and WorkoutZones.tsx's own `rows` were each
  // a fresh `filter().map()` / `zoneRows(...)` call over it, so the workout page's two charts (the
  // zone bar and the heart rate trace) were disposed and reinitialised on every commit - window
  // focus, opening or closing the annotate panel, and the session-scope invalidation M8b itself
  // added among them. This is the same defect the two Dashboard cases above guard, on a page
  // neither of them ever mounts.
  it('are not disposed and re-initialised on the workout page either, where WorkoutZones and WorkoutTrace live', async () => {
    const restore = stubWorkoutFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', '/activity/run1')
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<WorkoutDetail />)) })
    await flush(client, () => container!.innerHTML)

    const before = chartRoots()
    // The zone bar (a light and a peak zone recorded) and the heart rate trace (the pinned source
    // answers real points): two charts on this fixture, neither absent.
    expect(before).toHaveLength(2)
    expect(before.every((node) => node !== null)).toBe(true)

    // A second render of the same component with the same client: every query is already settled
    // and staleTime is Infinity, so nothing either chart draws has changed.
    act(() => { root!.render(tree(<WorkoutDetail />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const after = chartRoots()
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i], `chart ${i} was re-initialised`).toBe(before[i])
    }
    restore()
  })

  // M8c's own missing guard: the night page carries up to four charts (one Hypnogram plus up to
  // three IntradayHeartRate traces, NightTraces.tsx's own NIGHT_TRACE_METRICS), and this branch
  // added it without a chart-lifecycle case for any of them. The reviewer traced NightStages' own
  // `segments` (a useMemo keyed on `night`, itself a stable object once useNights' query settles)
  // and NightTrace's own `trace.points` (identically memo-free but sourced from a settled,
  // staleTime: Infinity query) and believes today's page is clean - this is the guard that would
  // have caught it if it were not, the same shape the three cases above already prove out on
  // Dashboard and the workout page.
  it('are not disposed and re-initialised on the night page either, where NightStages and NightTraces live', async () => {
    const restore = stubNightFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', '/sleep/night/2026-08-03')
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<NightDetail />)) })
    await flush(client, () => container!.innerHTML)

    const before = chartRoots()
    // The hypnogram (one staged segment) and the heart_rate trace (pinned to the night's own
    // source, which answered real points): two charts on this fixture, neither absent. spo2 and
    // hrv both pin to 'watch', find nothing, and fall back to every other source finding nothing
    // either, so they stay absent the same way NightTraces' own "renders a card only for the
    // metrics something actually recorded" test already covers - this fixture does not need all
    // three to exercise the same identity chain a fourth chart would.
    expect(before).toHaveLength(2)
    expect(before.every((node) => node !== null)).toBe(true)

    // A second render of the same component with the same client: every query is already settled
    // and staleTime is Infinity, so nothing either chart draws has changed.
    act(() => { root!.render(tree(<NightDetail />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const after = chartRoots()
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i], `chart ${i} was re-initialised`).toBe(before[i])
    }
    restore()
  })
})
