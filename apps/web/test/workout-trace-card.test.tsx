// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: WorkoutTrace mounts IntradayHeartRate, whose own
// useChart effect calls echarts.init, the same reason intraday-chart.test.tsx and
// chart-marks.test.tsx give for their own files. echarts.init itself is mocked below so this file
// never touches a real canvas.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { workoutDetail } from '@haelan/core/workout-summary'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { WorkoutSession } from '../src/data/useSessions.js'
import { WorkoutTrace } from '../src/pages/activity/WorkoutTrace.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { flush } from './flush.js'

// Task 4 review finding: WorkoutTrace.tsx itself had no test of its own, only the hook it calls.
// This file covers the three behaviours section 3 of the design specifies at the card level: the
// card is absent (not an empty chart) when nobody recorded anything, the basis line says the
// fallback fired and names the pinned device, and the pause markers filter to PAUSE with a real
// atMs.

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason intraday-chart.test.tsx and chart-marks.test.tsx set them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance, the same stub intraday-chart.test.tsx and
 * chart-marks.test.tsx use, so `setOption`'s own argument (the option IntradayHeartRate actually
 * built) can be captured without a real canvas.
 */
function chartStub() {
  return { on: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }
}
type ChartStub = ReturnType<typeof chartStub>
const chartStubs: ChartStub[] = []

vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => {
      const stub = chartStub()
      chartStubs.push(stub)
      return stub
    },
  }
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

const SESSION: WorkoutSession = {
  id: 'run1', sourceId: 'watch',
  startMs: Date.UTC(2026, 7, 3, 6, 0), endMs: Date.UTC(2026, 7, 3, 6, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: { exerciseType: 'RUNNING' },
  excluded: false, excludeReason: null,
}

const point = (sourceId: string) => ({
  sourceId, utcMs: Date.UTC(2026, 7, 3, 6, 10), min: 120, mean: 130, max: 140, n: 1, excluded: false,
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  chartStubs.length = 0
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

/** `answers` decides, per `source` query parameter value ('' for a request that sent none), what
 *  the window route returns. `sources` seeds the named-source list `useSourceNames` reads. */
function stub(answers: Record<string, unknown[]>, sources: unknown[] = []): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sources')) return json({ items: sources })
    if (url.includes('/intraday/window')) {
      const source = new URLSearchParams(url.split('?')[1] ?? '').get('source') ?? ''
      return json({ points: answers[source] ?? [], reduction: null })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function mount(node: React.ReactElement): { client: QueryClient, html: () => string } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">{node}</I18nProvider>
      </QueryClientProvider>,
    )
  })
  return { client, html: () => container?.innerHTML ?? '' }
}

describe('the workout trace card', () => {
  it('renders no card at all when nobody recorded anything, rather than an empty chart', async () => {
    const restore = stub({ watch: [], '': [] })
    try {
      const detail = workoutDetail({})
      const { client, html } = mount(<WorkoutTrace session={SESSION} detail={detail} chosenSource={null} />)
      await flush(client, html)
      // Not just "no chart visible": nothing at all, the same absence WorkoutZones' own
      // "no card at all when the session recorded no zones" test asserts for its own card.
      expect(html()).toBe('')
    } finally { restore() }
  })

  it('says the fallback fired and names the pinned device, when the recording device logged nothing', async () => {
    const restore = stub(
      { watch: [], '': [point('phone')] },
      [{ id: 'watch', externalId: 'watch-ext', displayName: 'Pixel Watch 4', alias: 'My Watch', name: 'My Watch', kind: 'device', createdAtMs: 0 }],
    )
    try {
      const detail = workoutDetail({})
      const { client, html } = mount(<WorkoutTrace session={SESSION} detail={detail} chosenSource={null} />)
      await flush(client, html)
      // The exact sentence, not a substring of it: the basis line has to both say the fallback
      // fired and name the pinned device (the one that logged nothing), not the source that
      // actually answered.
      expect(container?.querySelector('.basis')?.textContent).toBe(
        'My Watch recorded no heart rate in this window, so this is every other device instead; '
        + 'these 1 points are the readings',
      )
    } finally { restore() }
  })

  it('marks only PAUSE events that carry a real instant, never another kind or a null one', async () => {
    const restore = stub({ watch: [point('watch')] })
    try {
      // A kept PAUSE with a time, a PAUSE eventsFrom kept for its type alone (no parseable time -
      // workoutSummary.ts's own comment on why that half-broken entry is still kept), and a STOP
      // with a time. Only the first should ever reach the chart as a marker.
      const detail = workoutDetail({
        exerciseEvents: [
          { eventTime: '2026-08-03T06:10:00.000Z', exerciseEventType: 'PAUSE' },
          { exerciseEventType: 'PAUSE' },
          { eventTime: '2026-08-03T06:20:00.000Z', exerciseEventType: 'STOP' },
        ],
      })
      const { client, html } = mount(<WorkoutTrace session={SESSION} detail={detail} chosenSource={null} />)
      await flush(client, html)
      expect(html()).not.toBe('')

      const option = chartStubs.at(-1)!.setOption.mock.calls[0]![0] as {
        series: { markLine?: { data: { xAxis: number }[] } }[]
      }
      // One source (watch) draws three series (min, range, mean); the events series is appended
      // after them, at index 3.
      const events = option.series[3]!
      expect(events.markLine?.data).toEqual([{ xAxis: Date.UTC(2026, 7, 3, 6, 10) }])
    } finally { restore() }
  })
})
