// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because the wiring tests below need a real mount
// (createRoot + act) so useChart's own useEffect actually runs and calls echarts.init. The table
// tests further down still use renderToStaticMarkup, which runs no effects and so never touches
// echarts at all regardless of which environment the file runs under; moving to happy-dom does
// not change what they exercise.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { Sparkline, sparklinePointDate } from '../src/charts/Sparkline.js'
import { ActivityHeatmap, heatmapClickDate } from '../src/charts/ActivityHeatmap.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { DayRow } from '../src/fixtures/july.js'

// No I18nProvider anywhere in this file, on purpose: the same reason metric-card.test.tsx's own
// copy of this note gives. With no i18next instance initialised, t() returns the key it was asked
// for, so asserting on 'charts.absence.excluded' is asserting on the key the component chose, not
// on translated copy a locale file is free to reword.
const render = (node: React.ReactElement) => renderToStaticMarkup(node)

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason pages.test.tsx and chart-lifecycle.test.tsx set them. Needed even though
// echarts.init itself is mocked below: build(currentChartTokens()) still runs before the mocked
// setOption ever sees its argument.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance useChart.ts creates, so the wiring tests below can
 * mount a chart for real (running the actual useEffect, the actual `chart.on('click', ...)` call,
 * the actual ref, the actual onPointClick guard) without asking zrender to resolve a coordinate
 * against a rendered SVG, which an earlier experiment for this task established does not work
 * under happy-dom no matter how the click is simulated. Capturing the function handed to
 * `chart.on('click', ...)` and calling it directly exercises the same two lines a real click would
 * reach; only the browser's own hit-testing is out of scope, and it was never in scope, since
 * chart-annotations.test.tsx already draws that line at the accessible table for the rest of this
 * file.
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

// useChart's own echarts.init call lives inside a useEffect, and renderToStaticMarkup runs no
// effects (render-environment.test.tsx's own point), so a Sparkline or ActivityHeatmap renders
// here without ever touching echarts, CHART_VARS, or a canvas. What's left standing is exactly
// the accessible table ChartFigure builds beside the chart host, which is the surface this file
// asserts against; the marks drawn on the chart itself are canvas-only and out of a test's reach,
// as the brief for this task states.
function table(html: string): string {
  const match = html.match(/<table class="sr-only">[\s\S]*?<\/table>/)
  if (!match) throw new Error(`no accessible table in:\n${html}`)
  return match[0]
}

describe('Sparkline', () => {
  const values = [10, 20, 30]
  const labels = ['2026-08-01', '2026-08-02', '2026-08-03']

  it('marks an excluded date rather than dropping its row', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[]} excluded={['2026-08-02']} />,
    )
    const rows = table(html)
    // Still three rows: an override marks a point, it does not remove it from the record.
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    expect(rows).toContain('2026-08-02')
    expect(rows).toContain('charts.absence.excluded')
    // The two untouched days carry no such note.
    const day1Row = rows.slice(rows.indexOf('2026-08-01'), rows.indexOf('2026-08-02'))
    expect(day1Row).not.toContain('charts.absence.excluded')
  })

  it('carries an annotation’s own text into its row', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[{ date: '2026-08-03', text: 'Flight to Chicago' }]} excluded={[]} />,
    )
    const rows = table(html)
    expect(rows).toContain('Flight to Chicago')
  })

  it('leaves the table exactly as before when neither prop is passed', () => {
    // annotations/excluded default to empty rather than being required, so a page that has not
    // been migrated to pass them yet (every current caller) keeps compiling and keeps rendering
    // the same table it always has.
    const html = render(<Sparkline values={values} labels={labels} label="steps" unit="steps" />)
    const rows = table(html)
    expect(rows).not.toContain('charts.absence.excluded')
  })

  describe('sparklinePointDate', () => {
    it('reads the local date off a genuine series click', () => {
      expect(sparklinePointDate(labels, { componentType: 'series', dataIndex: 1 })).toBe('2026-08-02')
    })

    it('reports no date for a click on the excluded markPoint overlay', () => {
      // A markPoint click reports its own componentType, and its dataIndex counts into the
      // markPoint's own (much shorter) data array, not into `labels`: treating it as a series
      // click would report the wrong date, or one that does not exist, for most clicks on a mark.
      expect(sparklinePointDate(labels, { componentType: 'markPoint', dataIndex: 0 })).toBeUndefined()
    })
  })
})

describe('ActivityHeatmap', () => {
  const days: DayRow[] = [
    { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    { date: '2026-07-07', steps: 9000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    { date: '2026-07-08', steps: 5000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
  ]

  it('marks an excluded date rather than dropping its row', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[]} excluded={['2026-07-07']} />,
    )
    const rows = table(html)
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    expect(rows).toContain('2026-07-07')
    expect(rows).toContain('charts.absence.excluded')
  })

  it('carries an annotation’s own text into its row', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[{ date: '2026-07-08', text: 'Three glasses of wine' }]} excluded={[]} />,
    )
    const rows = table(html)
    expect(rows).toContain('Three glasses of wine')
  })

  it('leaves the table exactly as before when neither prop is passed', () => {
    // Same default-empty-array device Sparkline's own copy of this test guards, and the same
    // reason: every current caller (Activity.tsx) does not pass annotations/excluded yet.
    const html = render(<ActivityHeatmap days={days} max={9000} label="calendar heatmap" />)
    const rows = table(html)
    expect(rows).not.toContain('charts.absence.excluded')
  })

  describe('heatmapClickDate', () => {
    const cells = [
      { date: '2026-07-06', week: 0, weekday: 0 },
      { date: '2026-07-07', week: 0, weekday: 1 },
      { date: '2026-07-08', week: 0, weekday: 2 },
    ]

    it('reads the local date off the [week, weekday, steps] tuple a genuine series click reports', () => {
      expect(heatmapClickDate(cells, { componentType: 'series', value: [0, 1, 9000] })).toBe('2026-07-07')
    })

    it('reads the local date off the shorter [week, weekday] tuple the absence scatter series reports', () => {
      expect(heatmapClickDate(cells, { componentType: 'series', value: [0, 2] })).toBe('2026-07-08')
    })

    it('reports no date for a click on the excluded or annotation markPoint overlay', () => {
      // A markPoint's own value is a marker descriptor (name/coord/itemStyle), not a [week,
      // weekday] tuple, so this both fails the shape check on its own terms and is guarded by the
      // same componentType check sparklinePointDate uses.
      expect(heatmapClickDate(cells, { componentType: 'markPoint', value: undefined })).toBeUndefined()
    })
  })
})

// The pure functions above prove the date arithmetic; they say nothing about whether a real click
// ever reaches `onPointClick`, since neither Sparkline nor ActivityHeatmap calls them directly.
// The actual path is chart.on('click', handleClick) -> the onClickRef useChart.ts keeps -> the `if
// (date !== undefined)` guard each chart's own onClick wraps sparklinePointDate/heatmapClickDate
// in. Dropping the third argument to useChart, or inverting that guard, would leave every test
// above green. These tests mount for real (so the actual useEffect runs and actually calls
// chart.on) and invoke the captured handler directly (so no coordinate ever needs resolving).
describe('the click each chart hands to onPointClick', () => {
  it('Sparkline reports the label at the series point a genuine click landed on', () => {
    const onPointClick = vi.fn()
    act(() => {
      root!.render(
        <Sparkline values={[10, 20, 30]} labels={['2026-08-01', '2026-08-02', '2026-08-03']}
          label="steps" unit="steps" onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', dataIndex: 1 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-02')
  })

  it('Sparkline does not call back for a click that misses the series', () => {
    const onPointClick = vi.fn()
    act(() => {
      root!.render(
        <Sparkline values={[10, 20, 30]} labels={['2026-08-01', '2026-08-02', '2026-08-03']}
          label="steps" unit="steps" onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', dataIndex: 0 })
    expect(onPointClick).not.toHaveBeenCalled()
  })

  it('ActivityHeatmap reports the date the clicked cell’s [week, weekday, steps] tuple names', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-07', steps: 9000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-08', steps: 5000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(<ActivityHeatmap days={days} max={9000} label="calendar heatmap" onPointClick={onPointClick} />)
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', value: [0, 1, 9000] })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-07-07')
  })

  it('ActivityHeatmap does not call back for a click on a markPoint overlay', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(<ActivityHeatmap days={days} max={9000} label="calendar heatmap" onPointClick={onPointClick} />)
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', value: undefined })
    expect(onPointClick).not.toHaveBeenCalled()
  })
})
