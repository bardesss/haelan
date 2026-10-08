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
import { Recovery } from '../src/pages/Recovery.js'
import { Sleep } from '../src/pages/Sleep.js'
import { SLEEP_PERIOD_MONTH } from './fixtures/sleepPeriod.js'
import { RECOVERY_PERIOD_MONTH } from './fixtures/recoveryPeriod.js'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { NightDetail } from '../src/pages/NightDetail.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { seriesPoint, insightBody } from './metricCoverage.js'
import { glanceBody } from './glanceFixture.js'
import { nightPageFixture } from './fixtures/nightPage.js'
import { workoutPageFixture } from './fixtures/workoutPage.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this.
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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
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
    // A real override plus a real note and a real event, all on the same day: task 11b's own merge
    // has to keep every one of these arrays stable across a rerender, on both branches, not only on
    // an empty page. The override is on heart_rate because Recovery's week tab draws that metric's
    // range chart (the case below that mounts it), so the "metric already has annotations" branch
    // of mergeDayAnnotations, the one that concatenates a fresh array, reaches a chart. It sat on
    // resting_heart_rate while the old Recovery drew that metric's own sparkline, and on steps
    // before that, which only the old Dashboard drew; the glance reads no annotations.
    if (url.includes('/overrides')) {
      return json({
        items: [{
          id: 'o1', scope: 'day_metric',
          targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'heart_rate' }),
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
          // measurement), and the pages that draw a night read its length unconditionally for the
          // excluded-sessions line, the same field sleep-page.test.tsx's own fixture already sends.
          excludedSessions: [],
          segments: [{ stage: 'DEEP', startMs: start, endMs: start + 6 * 3_600_000 }],
        }],
        cursor: null,
      })
    }
    if (url.includes('/insights')) return json(insightBody(url))
    // The glance Dashboard's one read, carrying a night (the hypnogram) and today's heart rate
    // points (the trace), so both of its echarts instances mount.
    if (url.includes('/glance')) return json(glanceBody())
    // The Recovery overview's one read, the week tab's case below.
    if (url.includes('/recovery/period')) return json(RECOVERY_PERIOD_MONTH)
    // useSourceNames (IntradayHeartRate's own nameOf): reached by the glance's Today card, the place
    // this file mounts that chart.
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

// A session carrying both a heart rate zone breakdown (workout/WorkoutZones.tsx's own ZoneBar) and
// a PAUSE event with a real instant (workout/WorkoutThrough.tsx's own eventMarks), so both of the
// workout page's echarts instances actually mount - one from a fresh `zoneRows(...)` call and one
// from a fresh `filter().map()`, if either file went back to computing it inline on every render.
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
    // The workout page's own read (M10a): the shared fixture's every figure and strip, filed under
    // this case's session.
    if (url.includes('/workout/')) return json({ ...workoutPageFixture(), sessionId: WORKOUT_SESSION.id, localDate: WORKOUT_SESSION.localDate })
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
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

// A night carrying one staged segment (so the night card mounts a Hypnogram) and a real
// heart_rate reading pinned to its own source (so its traces mount one IntradayHeartRate) -
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
    // The night page's own read (M10a), carrying the same night so the sections still below the
    // new ones draw the hypnogram and the trace from it: the shared fixture's every figure and
    // strip, filed under this case's date.
    if (url.includes('/night/')) return json({ ...nightPageFixture(), localDate: NIGHT_FIXTURE.localDate, night: NIGHT_FIXTURE })
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

/**
 * The Sleep page's own routes, for the balance card's case below: the period read answers the
 * synthetic month fixture (M10b), whose every section has something to draw, and /sleep/nights the
 * one night the schedule's naps are read from.
 */
function stubSleepFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] } })
    }
    if (url.includes('/overrides') || url.includes('/notes') || url.includes('/events')) return json({ items: [] })
    if (url.includes('/sources')) {
      return json({
        items: [{
          id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4',
          alias: null, name: 'Pixel Watch 4', kind: 'device', createdAtMs: 0,
        }],
      })
    }
    if (url.includes('/series')) {
      const body: Record<string, unknown> = {}
      for (const metric of new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')) {
        body[metric] = {
          points: [
            '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14',
          ].map((date, i) => seriesPoint(metric, date, 400 + i * 20)),
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/sleep/period')) return json(SLEEP_PERIOD_MONTH)
    if (url.includes('/sleep/nights')) {
      const start = Date.parse('2026-08-12T22:00:00Z')
      return json({
        items: [{
          localDate: '2026-08-13', sourceId: 'watch', sessionIds: ['s1'],
          startMs: start, endMs: start + 7 * 3_600_000,
          startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], excludedSessions: [],
          segments: [{ stage: 'DEEP', startMs: start, endMs: start + 7 * 3_600_000 }],
        }],
        cursor: null,
      })
    }
    if (url.includes('/insights')) return json(insightBody(url))
    // One baseline for the whole page answered without a `thin` flag set, which is what puts the
    // balance card on the person's own usual rather than on their target: the branch that reads
    // `center` is the one whose memo a lifecycle defect would be hiding in.
    return json({ baseline: { center: 420, spread: 25, n: 55, thin: false } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the charts across a rerender', () => {
  // Section 7 of the spec names "a chart disposed on every render" as one of the two defect
  // classes the render environment was added to catch, and it came back one task later: useChart
  // keys its effect on `build`, every chart's `build` is a useCallback over its data props, and
  // the page handed all five of them freshly constructed arrays on every commit. With eight
  // queries settling at different moments that is roughly eight teardowns and rebuilds of five
  // echarts instances on a single page load.
  //
  // The page is the glance since M9b: one read, and three kinds of chart built from it (the
  // hypnogram from the night's segments made relative to its start, the heart rate trace from
  // today's points, and a seven-day strip per card). The segments are mapped on the page, so a
  // mapping recomputed on every render rather than memoised on the night would hand the hypnogram
  // a new array each commit and fail this the same way the original defect did. The glance reads
  // no annotations, so the annotation merge (mergeDayAnnotations) is not exercised here: the
  // Recovery week-tab case below is the one that guards it.
  it('are not disposed and re-initialised when nothing they draw has changed', async () => {
    const restore = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', '/')
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<Dashboard />)) })
    await flush(client, () => container!.innerHTML)

    const before = chartRoots()
    // The hypnogram and the heart rate trace, by name, so this cannot pass on the strips alone.
    expect(container!.querySelector('[role="img"][aria-label^="Sleep stages through the night that ended"]')).not.toBeNull()
    expect(container!.querySelector('[role="img"][aria-label="Heart rate today"]')).not.toBeNull()
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

  // The overridden metric's own guard. The stub puts an override on heart_rate, so the heart rate
  // range is handed that metric's own entry from overridesByMetric (its reasons and excluded days)
  // rather than the shared empty one every other metric falls back to. The entry is built per
  // render unless the page's memo on the map holds, so dropping it would hand the chart a new
  // `annotations` on every render and rebuild it; the shared empty entry alone would never show
  // it. (Recovery hands the range no day notes or events since the overview, so the day merge is
  // no longer part of this case.) The overview's hero and figure strips are memoised on the period
  // read, and are held to the same rule here.
  it('are not disposed and re-initialised on Recovery\'s week tab, where an overridden metric carries its own annotations', async () => {
    const restore = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', '/recovery?range=week&on=2026-08-12')
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<Recovery />)) })
    await flush(client, () => container!.innerHTML)

    // The overridden metric's own chart is on the page, so the case cannot pass without it.
    const hosts = [...container!.querySelectorAll('[role="img"]')]
    expect(hosts.some((host) => (host.getAttribute('aria-label') ?? '').startsWith('Daily heart rate minimum, mean and maximum'))).toBe(true)
    const before = chartRoots()
    expect(before.every((node) => node !== null)).toBe(true)

    act(() => { root!.render(tree(<Recovery />)) })
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
  // on every render. Its own case here mounted Recovery's Day tab until the Recovery overview, whose
  // Day tab opens the dashboard on that day instead of drawing a trace; the glance's Today card is
  // where IntradayHeartRate lives on a page now, and the first case above ("Heart rate today")
  // holds it to the rule.

  // Final review finding on M8b: WorkoutDetail.tsx built `detail` fresh from `workoutDetail(...)`
  // on every render, and workout/WorkoutThrough.tsx's own `marks` and workout/WorkoutZones.tsx's
  // own `rows` were each a fresh `filter().map()` / `zoneRows(...)` call over it, so the workout
  // page's two charts (the zone bar and the heart rate trace) were disposed and reinitialised on
  // every commit - window focus, opening or closing the annotate panel, and the session-scope
  // invalidation M8b itself added among them. This is the same defect the cases above guard
  // (the Dashboard, and Recovery's week tab), on a page neither of them ever mounts.
  it('are not disposed and re-initialised on the workout page either, where its strips, zones and trace live', async () => {
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
    // The hero's pace strip and the four figures' strips (M10a: each a Sparkline whose arrays and
    // formatter come out of a memo on the payload), then the zone bar (a light and a peak zone
    // recorded), the heart rate trace (the pinned source answers real points) with the pace and
    // cadence rows under it (M10b: each a memo on the payload's series), the same route's pace and
    // time strips (each a memo on its figure, with the dots' opener memoised too) and VO2max's strip
    // in More about this workout: twelve charts on this fixture, none absent.
    expect(container!.querySelector('.detail-hero [role="img"][aria-label="Pace"]')).not.toBeNull()
    expect(container!.querySelectorAll('.detail-minis [role="img"]')).toHaveLength(4)
    expect(before).toHaveLength(12)
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
  // added it without a chart-lifecycle case for any of them. Since M10a-2 the night card
  // (NightThrough.tsx) holds both: its `segments` are a useMemo keyed on `night`, and each trace's
  // usual band a useMemo keyed on its baseline, while `trace.points` comes from a settled,
  // staleTime: Infinity query. This is the guard that would catch any of them rebuilt per render,
  // the same shape the three cases above already prove out on the Dashboard, Recovery and the
  // workout page.
  it('are not disposed and re-initialised on the night page either, where its strips, stages and traces live', async () => {
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
    // The hero's time-asleep strip and the four figures' strips (M10a: each a Sparkline whose
    // arrays and formatter come out of a memo on the payload), then the hypnogram (one staged
    // segment) and the heart_rate trace (pinned to the night's own source, which answered real
    // points), then the week row's own two (M10a-2's NightWeek: SleepSchedule over the bedtime and
    // waketime strips, BalanceBars over `balance.nights`, both memoised the same way), then the
    // morning after's own ring (a static SVG, `role="img"` same as every echarts host) and its
    // resting-heart-rate, HRV and skin temperature strips (M10a-2's NightMorning, memoised the
    // same way as every other strip on this page): thirteen charts on this fixture, none absent. Task 7's own NightDay
    // card adds no chart of its own - its mood face (MoodFaces.tsx's exported MoodFace) is
    // decorative (`aria-hidden`, not `role="img"`; fix round 1's own finding on double
    // announcement), so it does not appear in `chartRoots()` either. spo2 and hrv's own NightTraces
    // row both pin to 'watch', find nothing, and fall back to every other source finding nothing
    // either, so that trace stays absent the same way NightTraces' own "renders a row only for the
    // metrics something actually recorded" test already covers - this fixture does not need all
    // three to exercise the same identity chain a fourth trace would.
    expect(container!.querySelector('.detail-hero [role="img"][aria-label="Time asleep"]')).not.toBeNull()
    expect(container!.querySelectorAll('.detail-minis [role="img"]')).toHaveLength(4)
    expect(container!.querySelector('[role="img"][aria-label="Sleep schedule"]')).not.toBeNull()
    expect(container!.querySelector('[role="img"][aria-label="Sleep balance"]')).not.toBeNull()
    expect(container!.querySelector('.night-grp [role="img"][aria-label="Resting heart rate"]')).not.toBeNull()
    expect(container!.querySelector('.night-grp [role="img"][aria-label="HRV this morning"]')).not.toBeNull()
    expect(container!.querySelector('.night-grp [role="img"][aria-label="Skin temperature"]')).not.toBeNull()
    expect(before).toHaveLength(13)
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

  // The Sleep overview's own case, on the page none of the four above mounts: the balance bars, the
  // stages, the schedule and every strip read arrays off the period read or a memo over it, so a
  // prop rebuilt every render (the list of hero dates, a stage's series, the schedule's nights, the
  // excluded dates) disposes and re-initialises its chart on every commit.
  it('are not disposed and re-initialised on the sleep page either, where the balance card lives', async () => {
    const restore = stubSleepFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    window.history.replaceState(null, '', '/sleep?range=week&on=2026-08-16')
    const tree = (node: ReactNode): ReactNode => (
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>
    )

    act(() => { root!.render(tree(<Sleep />)) })
    await flush(client, () => container!.innerHTML)

    // Every chart is on the page, so the case cannot pass by measuring a page that rendered nothing
    // to dispose: the hero's strip, the four figures', the stages, the schedule, the balance and
    // the mornings' strips. Eleven: the bedtime variability is a sentence now, with no strip.
    for (const label of ['Time asleep, average per night', 'The nights', 'Sleep schedule', 'Sleep balance', 'Resting heart rate']) {
      expect(container!.querySelector(`div[role="img"][aria-label="${label}"]`), label).not.toBeNull()
    }

    const before = chartRoots()
    expect(before).toHaveLength(11)
    expect(before.every((node) => node !== null)).toBe(true)

    // A second render of the same component with the same client: every query is already settled
    // and staleTime is Infinity, so nothing any chart draws has changed.
    act(() => { root!.render(tree(<Sleep />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const after = chartRoots()
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i], `chart ${i} was re-initialised`).toBe(before[i])
    }
    restore()
  })
})
