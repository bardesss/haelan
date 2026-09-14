// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: these mounts need useChart's own effect to run, so
// that `tap` is resolved and ChartFigure actually renders (or does not render) the annotate
// control - the same reason chart-tap.test.tsx and intraday-chart.test.tsx give for their own
// files. renderToStaticMarkup runs no effects and would answer "no control" for every case here,
// including the broken ones.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActivityHeatmap } from '../src/charts/ActivityHeatmap.js'
import { DailyBars } from '../src/charts/DailyBars.js'
import { HeartRateRange } from '../src/charts/HeartRateRange.js'
import { IntradayHeartRate } from '../src/charts/IntradayHeartRate.js'
import { Sparkline } from '../src/charts/Sparkline.js'
import { Spo2Range } from '../src/charts/Spo2Range.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import type { DayRow } from '../src/fixtures/july.js'
import type { Session } from '../src/auth/session.js'

// happy-dom applies no stylesheet, so build(currentChartTokens()) throws "missing chart token"
// without this, even with echarts.init stubbed below - the option is built before setOption is
// ever called.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

// The same stub intraday-chart.test.tsx uses: nothing here reads the drawn option, only whether a
// control was rendered beside it, so a real instance would be several hundred milliseconds of
// canvas work per case for no assertion.
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null
const realMatchMedia = window.matchMedia.bind(window)

/** Answers the phone query and hands every other query to happy-dom; see chart-tap.test.tsx. */
function pretendPhone(): void {
  window.matchMedia = ((query: string) => {
    if (query !== PHONE_MEDIA_QUERY) return realMatchMedia(query)
    return {
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
}

beforeEach(() => {
  pretendPhone()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  window.matchMedia = realMatchMedia as typeof window.matchMedia
})

const DAYS: DayRow[] = [
  { date: '2026-09-01', steps: 7100, hrMin: 52, hrMean: 61, hrMax: 140, sleepMinutes: 430, worn: true },
  { date: '2026-09-02', steps: 8200, hrMin: 50, hrMean: 60, hrMax: 132, sleepMinutes: 445, worn: true },
]
const LABELS = DAYS.map((d) => d.date)
const VALUES = DAYS.map((d) => d.steps)
const SPO2_DAYS = LABELS.map((date) => ({ date, min: 94, mean: 96, max: 98, count: 120 }))
const POINTS = [0, 60_000].map((utcMs) => ({ sourceId: 'watch', utcMs, min: 55, mean: 60, max: 65, n: 1, excluded: false }))

const SESSION: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'UTC',
  birthDate: null, sex: null, connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

/**
 * Every chart that declares an optional `onPointClick`, rendered twice: once with a handler and
 * once without. The pair is the whole point - asserting only the absent case would pass just as
 * well against a chart whose annotate control never renders at all, which proves nothing about
 * this defect.
 *
 * IntradayHeartRate reads the session and the source names, so it gets a seeded client; the other
 * five take their data entirely through props. The client is built per render rather than shared,
 * so nothing carries between cases.
 */
const CHARTS: { name: string, render: (onPointClick?: (...args: never[]) => void) => React.ReactNode }[] = [
  {
    name: 'ActivityHeatmap',
    render: (onPointClick) => <ActivityHeatmap days={DAYS} max={10_000} label="Steps"
      onPointClick={onPointClick as ((date: string) => void) | undefined} />,
  },
  {
    name: 'DailyBars',
    render: (onPointClick) => <DailyBars values={VALUES} labels={LABELS} label="Steps" unit="steps"
      axisUnit="steps" metric="steps"
      onPointClick={onPointClick as ((date: string) => void) | undefined} />,
  },
  {
    name: 'HeartRateRange',
    render: (onPointClick) => <HeartRateRange days={DAYS} annotations={[]} excluded={[]} label="Heart rate"
      onPointClick={onPointClick as ((date: string) => void) | undefined} />,
  },
  {
    name: 'IntradayHeartRate',
    render: (onPointClick) => <IntradayHeartRate points={POINTS} reduction={null} label="Heart rate"
      onPointClick={onPointClick as ((point: { sourceId: string, utcMs: number, n: number }) => void) | undefined} />,
  },
  {
    name: 'Sparkline',
    render: (onPointClick) => <Sparkline values={VALUES} labels={LABELS} label="Steps" unit="steps"
      metric="steps" onPointClick={onPointClick as ((date: string) => void) | undefined} />,
  },
  {
    name: 'Spo2Range',
    render: (onPointClick) => <Spo2Range days={SPO2_DAYS} annotations={[]} excluded={[]} label="SpO2"
      onPointClick={onPointClick as ((date: string) => void) | undefined} />,
  },
]

function mount(node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), SESSION)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  act(() => {
    root!.render(
      <I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>,
    )
  })
}

const annotateControl = (): HTMLButtonElement | null =>
  container!.querySelector<HTMLButtonElement>('.chart-annotate')

describe('the annotate control below the breakpoint', () => {
  // The defect this file exists for. Every one of these six declares `onPointClick` optional and
  // every one of them passed `{ onClick, describe }` to useChart unconditionally, so useChart's
  // own `isPhone && point` was true whether or not there was anything behind it. On the two detail
  // routes - WorkoutTrace.tsx and NightTraces.tsx, neither of which passes a handler - the control
  // rendered, armed itself on a tap, said "18:00 annoteren", and did nothing at all when pressed,
  // because `onClick` bottomed out in `onPointClick?.(...)`.
  //
  // useChart's own ChartPointHandlers doc comment claims the paired shape makes "can act but
  // cannot name" unrepresentable. It said nothing about the other direction, and the other
  // direction is what shipped.
  for (const chart of CHARTS) {
    it(`is absent when ${chart.name} has no onPointClick`, () => {
      mount(chart.render(undefined))
      expect(annotateControl()).toBeNull()
    })

    it(`is present when ${chart.name} has one`, () => {
      mount(chart.render(() => {}))
      expect(annotateControl()).not.toBeNull()
    })
  }
})
