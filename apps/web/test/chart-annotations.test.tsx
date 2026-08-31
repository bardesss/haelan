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
import { HeartRateRange, heartRateRangePointDate } from '../src/charts/HeartRateRange.js'
import { SYMBOL } from '../src/charts/base.js'
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

  // A corrected day was not dropped: its replacement value is the number already on screen, so
  // calling it "excluded" would tell a reader the opposite of what happened. This pins the two
  // apart, in the one channel this environment can see (chartAnnotations.ts's own doc comment has
  // the full reasoning; the visual markPoint difference is canvas-only and hand-verified below).
  it('marks a corrected date differently from an excluded one, carrying its own value', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[]} excluded={['2026-08-01']} corrected={[{ date: '2026-08-02', value: 42 }]} />,
    )
    const rows = table(html)
    const excludedRow = rows.slice(rows.indexOf('2026-08-01'), rows.indexOf('2026-08-02'))
    const correctedRow = rows.slice(rows.indexOf('2026-08-02'), rows.indexOf('2026-08-03'))
    expect(excludedRow).toContain('charts.absence.excluded')
    expect(excludedRow).not.toContain('charts.absence.correctedTo')
    expect(correctedRow).toContain('charts.absence.correctedTo')
    expect(correctedRow).not.toContain('charts.absence.excluded')
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

  // Same distinction Sparkline's own copy of this test pins, and the same reason: a corrected day
  // was not dropped, so telling a reader "excluded" over it says the opposite of what happened.
  it('marks a corrected date differently from an excluded one', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[]} excluded={['2026-07-06']} corrected={[{ date: '2026-07-07', value: 42 }]} />,
    )
    const rows = table(html)
    const excludedRow = rows.slice(rows.indexOf('2026-07-06'), rows.indexOf('2026-07-07'))
    const correctedRow = rows.slice(rows.indexOf('2026-07-07'), rows.indexOf('2026-07-08'))
    expect(excludedRow).toContain('charts.absence.excluded')
    expect(excludedRow).not.toContain('charts.absence.correctedTo')
    expect(correctedRow).toContain('charts.absence.correctedTo')
    expect(correctedRow).not.toContain('charts.absence.excluded')
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

describe('HeartRateRange', () => {
  // All three of annotations/excluded/corrected required, unlike Sparkline and ActivityHeatmap:
  // HeartRateRange has taken this trio since D1 (annotations/excluded) and this task (corrected),
  // never optional, so every render below passes all three regardless of whether it exercises one.
  const days: DayRow[] = [
    { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
    { date: '2026-08-11', steps: null, hrMin: 54, hrMean: 61, hrMax: 70, sleepMinutes: null, worn: true },
    { date: '2026-08-12', steps: null, hrMin: 56, hrMean: 59, hrMax: 66, sleepMinutes: null, worn: true },
  ]

  it('marks an excluded date rather than dropping its row', () => {
    const html = render(
      <HeartRateRange days={days} annotations={[]} excluded={['2026-08-11']} corrected={[]} label="hr range" />,
    )
    const rows = table(html)
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    expect(rows).toContain('2026-08-11')
    expect(rows).toContain('charts.absence.excluded')
  })

  it('carries an annotation’s own text into its row', () => {
    const html = render(
      <HeartRateRange days={days} annotations={[{ date: '2026-08-12', text: 'Flight to Chicago' }]}
        excluded={[]} corrected={[]} label="hr range" />,
    )
    const rows = table(html)
    expect(rows).toContain('Flight to Chicago')
  })

  // Same distinction Sparkline's and ActivityHeatmap's own copies of this test pin: a corrected
  // day was not dropped, so telling a reader "excluded" over it says the opposite of what
  // happened. HeartRateRange is the one chart carrying `!d.worn` in the same note cell, so this
  // also pins that a corrected mark does not fight the wear clause for the same cell.
  it('marks a corrected date differently from an excluded one', () => {
    const html = render(
      <HeartRateRange days={days} annotations={[]} excluded={['2026-08-10']}
        corrected={[{ date: '2026-08-11', value: 58 }]} label="hr range" />,
    )
    const rows = table(html)
    const excludedRow = rows.slice(rows.indexOf('2026-08-10'), rows.indexOf('2026-08-11'))
    const correctedRow = rows.slice(rows.indexOf('2026-08-11'), rows.indexOf('2026-08-12'))
    expect(excludedRow).toContain('charts.absence.excluded')
    expect(excludedRow).not.toContain('charts.absence.correctedTo')
    expect(correctedRow).toContain('charts.absence.correctedTo')
    expect(correctedRow).not.toContain('charts.absence.excluded')
  })

  describe('heartRateRangePointDate', () => {
    it('reads the local date off a genuine series click, regardless of which of the three stacked series it landed on', () => {
      // dataIndex is a position on the shared category axis, not tied to one series: min, range
      // and mean all report the same dataIndex for the same day.
      expect(heartRateRangePointDate(days, { componentType: 'series', dataIndex: 1 })).toBe('2026-08-11')
    })

    it('reports no date for a click on the excluded/corrected markPoint or the annotation markLine', () => {
      expect(heartRateRangePointDate(days, { componentType: 'markPoint', dataIndex: 0 })).toBeUndefined()
      expect(heartRateRangePointDate(days, { componentType: 'markLine', dataIndex: 0 })).toBeUndefined()
    })
  })

  // The Critical this task's review round found, in two layers. First: the markLine data below
  // used to be `annotations.map(...)` with no membership filter, unlike the markPoint four lines
  // above it in HeartRateRange.tsx and unlike both Sparkline's and ActivityHeatmap's own
  // markPoint/markLine filters, so an override from outside the visible range reached this chart
  // at all. Second, and the one the filter alone did not close: this chart's x axis is
  // `days.map(d => d.date.slice(8))`, a day-of-month label, and a category axis's markPoint/
  // markLine `xAxis` resolves a string against that axis's own `data` by name, matching the FIRST
  // entry that carries it. `.slice(8)` was still the positioning key after the filter landed, so
  // two visible days sharing a day-of-month (`3months`/`year` draw one point per calendar day
  // across several months, with no downsampling) collided on each other even though both passed
  // the filter and neither was out of range. Both cases are pinned below: the first against a day
  // genuinely outside `days`, the second against two in-range days that share a label. Reads
  // `setOption`'s own captured argument, since a mark's placement is drawn on the canvas and the
  // accessible table alone cannot tell either defect apart from its fix.
  describe('the annotation markLine only ever names a day this chart is actually drawing', () => {
    it('drops an annotation for a date outside the visible range rather than placing it on a day sharing its day-of-month', () => {
      act(() => {
        root!.render(
          <HeartRateRange days={days} excluded={[]} corrected={[]}
            annotations={[{ date: '2026-07-11', text: 'Watch left charging' }]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: { markLine?: { data: unknown[] } }[] }
      const meanSeries = option.series[2]!
      expect(meanSeries.markLine?.data).toEqual([])
    })

    it('draws an annotation for a date actually inside the visible range, positioned by index', () => {
      act(() => {
        root!.render(
          <HeartRateRange days={days} excluded={[]} corrected={[]}
            annotations={[{ date: '2026-08-11', text: 'Watch left charging' }]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: { markLine?: { data: unknown[] } }[] }
      const meanSeries = option.series[2]!
      // xAxis is 1, `days`' own array position for 2026-08-11, not the string "11": a numeric
      // category index cannot collide with another day the way a repeating day-of-month label can.
      expect(meanSeries.markLine?.data).toEqual([{ name: 'Watch left charging', xAxis: 1 }])
    })

    // The reviewer's own measurement: a six day range spanning two months, both sharing the same
    // three day-of-month labels ("10","11","12"), with an exclude and an annotation override on
    // the second month's "11" and a correct override on the second month's "10". A string
    // positioned mark resolves e.g. `"11"` against the axis's data and lands on the FIRST match,
    // 2026-07-11 (index 1), at 2026-07-11's own height; an index positioned mark lands on the day
    // actually named, 2026-08-11 (index 4), at its own mean. All three mark groups (excluded,
    // corrected, annotations) are checked in one range, since all three share the exact defect and
    // the exact fix: the round this test was first written in covered only excluded and
    // annotations, which left the third of the fix (the corrected markPoint entry, still keyed on
    // `date.slice(8)` at review time) provably able to regress with the whole suite staying green.
    it('resolves a mark to the day it actually names, not the first day sharing its day-of-month, across a two month range', () => {
      const twoMonthDays: DayRow[] = [
        { date: '2026-07-10', steps: null, hrMin: 50, hrMean: 55, hrMax: 60, sleepMinutes: null, worn: true },
        { date: '2026-07-11', steps: null, hrMin: 51, hrMean: 56, hrMax: 61, sleepMinutes: null, worn: true },
        { date: '2026-07-12', steps: null, hrMin: 52, hrMean: 57, hrMax: 62, sleepMinutes: null, worn: true },
        { date: '2026-08-10', steps: null, hrMin: 53, hrMean: 58, hrMax: 63, sleepMinutes: null, worn: true },
        { date: '2026-08-11', steps: null, hrMin: 54, hrMean: 64, hrMax: 70, sleepMinutes: null, worn: true },
        { date: '2026-08-12', steps: null, hrMin: 55, hrMean: 60, hrMax: 65, sleepMinutes: null, worn: true },
      ]
      act(() => {
        root!.render(
          <HeartRateRange days={twoMonthDays} excluded={['2026-08-11']}
            corrected={[{ date: '2026-08-10', value: 58 }]}
            annotations={[{ date: '2026-08-11', text: 'Watch left charging' }]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as {
        series: { markPoint?: { data: unknown[] }, markLine?: { data: unknown[] } }[]
      }
      const meanSeries = option.series[2]!
      // excluded at index 4 (2026-08-11, mean 64), never index 1 (2026-07-11, mean 56).
      // corrected at index 3 (2026-08-10, mean 58), never index 0 (2026-07-10, mean 55).
      expect(meanSeries.markPoint?.data).toEqual([
        { name: 'excluded', xAxis: 4, yAxis: 64 },
        { name: 'corrected', symbol: 'rect', symbolSize: SYMBOL.corrected, itemStyle: { color: '#000000' }, xAxis: 3, yAxis: 58 },
      ])
      expect(meanSeries.markLine?.data).toEqual([{ name: 'Watch left charging', xAxis: 4 }])
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

  // HeartRateRange gained onPointClick in this same review round, following the ref based pattern
  // the two charts above already use: the handler lives outside `build`'s own dependency array
  // (useChart.ts keeps it in a ref), so a fresh closure every render never disposes the chart.
  it('HeartRateRange reports the date at the dataIndex a genuine click landed on', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
      { date: '2026-08-11', steps: null, hrMin: 54, hrMean: 61, hrMax: 70, sleepMinutes: null, worn: true },
      { date: '2026-08-12', steps: null, hrMin: 56, hrMean: 59, hrMax: 66, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <HeartRateRange days={days} annotations={[]} excluded={[]} corrected={[]} label="hr range"
          onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', dataIndex: 1 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-11')
  })

  it('HeartRateRange does not call back for a click on an overlay', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <HeartRateRange days={days} annotations={[]} excluded={[]} corrected={[]} label="hr range"
          onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', dataIndex: 0 })
    expect(onPointClick).not.toHaveBeenCalled()
  })
})
