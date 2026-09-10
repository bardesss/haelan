// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: the wiring tests below need a real mount (createRoot
// + act) so useChart's own useEffect actually runs and calls echarts.init and chart.on('click', ...),
// the same reason chart-marks.test.tsx and intraday-chart.test.tsx give for their own files.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { EChartsOption } from 'echarts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntradayHeartRate } from '../src/charts/IntradayHeartRate.js'
import type { IntradayPoint } from '../src/data/useIntraday.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { I18nProvider } from '../src/i18n/index.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { SYMBOL } from '../src/charts/base.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason intraday-chart.test.tsx sets them. Needed even though echarts.init itself
// is mocked below: build(currentChartTokens()) still runs before the mocked setOption ever sees it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance useChart.ts creates, the same stub chart-marks.test.tsx
 * and intraday-chart.test.tsx use for their own wiring tests: capturing the function handed to
 * `chart.on('click', ...)` and calling it directly exercises the same path a real click would,
 * without asking zrender to resolve a coordinate against a rendered SVG under happy-dom.
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

/** The function useChart.ts actually passed to `chart.on('click', ...)`, i.e. `handleClick`. */
function clickHandlerOf(stub: ChartStub): (event: unknown) => void {
  const call = stub.on.mock.calls.find(([event]) => event === 'click')
  if (!call) throw new Error('chart.on was never called with "click"')
  return call[1] as (event: unknown) => void
}

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

const SESSION: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'UTC', connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * Mounts IntradayHeartRate inside a QueryClientProvider with the session and an empty
 * sourceNamesKey('p1') seeded, the same device intraday-chart.test.tsx's own optionForPoints uses,
 * so nameOf falls back to the bare source id and no unmocked fetch runs in this environment.
 */
function mountChart(
  points: IntradayPoint[],
  onPointClick?: (point: { sourceId: string, utcMs: number, n: number }) => void,
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), SESSION)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <QueryClientProvider client={client}>
          <IntradayHeartRate points={points} reduction={null} label="Heart rate" onPointClick={onPointClick} />
        </QueryClientProvider>
      </I18nProvider>,
    )
  })
}

function optionFor(points: IntradayPoint[]): EChartsOption {
  mountChart(points)
  return chartStubs.at(-1)!.setOption.mock.calls[0]![0] as EChartsOption
}

const point = (utcMs: number, sourceId: string, mean: number, extra: Partial<IntradayPoint> = {}): IntradayPoint =>
  ({ sourceId, utcMs, min: mean - 5, mean, max: mean + 5, n: 1, excluded: false, ...extra })

describe('a click on the intraday chart names a sample', () => {
  // The point of this task: a by-day chart's onPointClick reports a localDate alone, but a click
  // here names one (source, minute) bucket, which a sample target needs sourceId, utcMs and n to
  // encode (AnnotatePanel.tsx's own AnnotateTarget). n travels through untouched so the panel's
  // Correct guard can read it without a second request.
  it('hands the clicked point its sourceId, utcMs and n', () => {
    const onPointClick = vi.fn()
    mountChart([point(0, 'watch', 60), point(60000, 'watch', 70)], onPointClick)
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    // One source: min, range, mean in that order, so the mean line is series index 2.
    handleClick({ componentType: 'series', seriesIndex: 2, dataIndex: 1 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith({ sourceId: 'watch', utcMs: 60000, n: 1 })
  })

  it('reports a raw metric point\'s own n, not 1, when several readings shared its minute', () => {
    const onPointClick = vi.fn()
    mountChart([point(0, 'watch', 60, { n: 6 })], onPointClick)
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', seriesIndex: 2, dataIndex: 0 })
    expect(onPointClick).toHaveBeenCalledWith({ sourceId: 'watch', utcMs: 0, n: 6 })
  })

  // A click on the invisible min/range series (indices 0 and 1) names no reading of its own; only
  // the mean line (index 2) is in pointsBySeriesIndex at all.
  it('does not call back for a click that misses a source\'s mean line', () => {
    const onPointClick = vi.fn()
    mountChart([point(0, 'watch', 60)], onPointClick)
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', seriesIndex: 0, dataIndex: 0 })
    expect(onPointClick).not.toHaveBeenCalled()
  })

  // The excluded marker sits on top of the same reading, and reports its own dataIndex counting
  // into the marker's own markPoint.data array rather than into `points` (the same split
  // Sparkline/HeartRateRange draw between a series click and an overlay click), so this is the one
  // path that would silently stop resolving if the two lookups were ever collapsed into one.
  it('reports the same point when its excluded marker is clicked instead of the line', () => {
    const onPointClick = vi.fn()
    mountChart([point(0, 'watch', 60, { excluded: true })], onPointClick)
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', seriesIndex: 2, dataIndex: 0 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith({ sourceId: 'watch', utcMs: 0, n: 1 })
  })
})

describe('an excluded point renders with the excluded treatment', () => {
  // Same marker Sparkline and HeartRateRange draw over an excluded value: SYMBOL.excluded sizes
  // it, tokens.excluded colours it, and it is anchored at the point's own value rather than at a
  // placeholder, because a sample scoped exclusion never removes the point the way an applied
  // day_metric one does (readIntraday's own comment on `excluded` says why).
  it('draws a markPoint at the excluded reading\'s own value, and none for an ordinary one', () => {
    const option = optionFor([
      point(0, 'watch', 60, { excluded: true }),
      point(60000, 'watch', 70),
    ])
    const meanSeries = (option.series as { markPoint?: { data: unknown[], symbolSize: number } }[])[2]!
    expect(meanSeries.markPoint?.data).toEqual([{ name: 'excluded', coord: [0, 60] }])
    expect(meanSeries.markPoint?.symbolSize).toBe(SYMBOL.excluded)
  })

  it('adds no marker at all when nothing on the chart is excluded', () => {
    const option = optionFor([point(0, 'watch', 60), point(60000, 'watch', 70)])
    const meanSeries = (option.series as { markPoint?: { data: unknown[] } }[])[2]!
    expect(meanSeries.markPoint?.data).toEqual([])
  })

  // The accessible table's own copy of the same fact: charts.absence.excluded, the identical word
  // the day_metric charts' table cells use for the same meaning, not a second string invented here.
  it('marks the excluded row in the accessible table, and leaves the ordinary row blank', () => {
    mountChart([point(0, 'watch', 60, { excluded: true }), point(60000, 'watch', 70)])
    const rows = [...container!.querySelectorAll('table.sr-only tbody tr')]
    const cells = rows.map((row) => [...row.querySelectorAll('td, th')].map((cell) => cell.textContent))
    // [time, source, min, mean, max, note] per row (th is the time header cell); note is last.
    expect(cells[0]?.at(-1)).toBe('excluded')
    expect(cells[1]?.at(-1)).toBe('')
  })
})
