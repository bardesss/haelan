// @vitest-environment happy-dom
//
// happy-dom, and echarts/core mocked, for the reasons band-toggle.test.tsx's header gives: this
// file mounts a real chart component and re-renders it, and nothing here needs zrender.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { Sparkline } from '../src/charts/Sparkline.js'
import { DailyBars } from '../src/charts/DailyBars.js'
import { CHART_VARS } from '../src/charts/tokens.js'

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const dispose = vi.fn()
// Captured rather than left a bare vi.fn(): the bandLabels suite at the foot of this file needs to
// read the option a render actually produced, and this is the one seam (useChart hands its built
// option straight to the echarts instance's setOption) that lets a test see it without reaching
// into echarts' own internals.
let lastOption: unknown
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: vi.fn(), setOption: (option: unknown) => { lastOption = option }, dispose, resize: vi.fn() }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  dispose.mockClear()
  lastOption = undefined
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

const values = [9000, 8600, 9400]
const labels = ['2026-08-10', '2026-08-11', '2026-08-12']

// A fresh arrow every call, which is exactly what Activity.tsx:303 (its Sparkline call site) and
// Weight.tsx:250 hand this component: `sparkFormat` is a parameter of a card() helper invoked
// inline during render, so its identity changes on every render even though its behaviour never
// does. Activity.tsx has a second call site, at line 293, handing the identical fresh arrow to
// DailyBars instead -- the "a daily bars chart across a rerender" block below pins the same
// property for that chart.
const freshFormatValue = () => (v: number | null, absent: string) => v === null ? absent : String(v)

function render() {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
          formatValue={freshFormatValue()} />
      </I18nProvider>,
    )
  })
}

describe('a sparkline across a rerender', () => {
  // The defect this guards is the one chart-lifecycle.test.tsx guards at the page level: useChart
  // keys its init/dispose effect on `build`, so anything folded into `build`'s dependency array
  // that changes identity per render disposes and re-initialises the chart for a reason that has
  // nothing to do with what it draws. The tooltip needs `formatValue`, `t` and the language; they
  // reach it through a ref precisely so that this stays true.
  it('is not disposed when the caller passes a new formatValue identity', () => {
    render()
    dispose.mockClear()
    render()
    expect(dispose).not.toHaveBeenCalled()
  })

  // The opposite pin, for the value fix round 1 made: `bandLabels` is read directly inside `build`
  // (both the grid's right margin and the markPoint data below use it), so unlike `formatValue`
  // above it belongs in `build`'s own dependency array, not behind a ref. Leaving it out would pass
  // every other test in this file - nothing here calls setOption twice with different bandLabels and
  // diffs the result - while quietly serving a stale band label from before the caller's baseline
  // (and its low/high text) changed. Asserting the option updates is the only way to catch that a
  // rebuild happened at all, since this mock's `dispose` is the sole rebuild signal this file has.
  it('is disposed and rebuilt when bandLabels changes, since build reads it directly', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} />
        </I18nProvider>,
      )
    })
    dispose.mockClear()
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,100', high: '9,400' }} />
        </I18nProvider>,
      )
    })
    expect(dispose).toHaveBeenCalled()
  })
})

function renderBars() {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <DailyBars values={values} labels={labels} metric="distance" unit="Distance in kilometers"
          axisUnit="km" label="distance, august 2026" formatValue={freshFormatValue()} />
      </I18nProvider>,
    )
  })
}

describe('a daily bars chart across a rerender', () => {
  // The same design, and the same defect, as the Sparkline guard above: DailyBars.tsx:109's value
  // axis reads `formatValue` through tooltipRef rather than through `build`'s own dependency
  // array, for the identical reason (Activity.tsx's distance and floors cards hand it a fresh
  // arrow every render, from the same `sparkFormat` parameter of card()). Nothing had rerendered a
  // DailyBars before this test, so nothing had proven that design actually held for this chart.
  it('is not disposed when the caller passes a new formatValue identity', () => {
    renderBars()
    dispose.mockClear()
    renderBars()
    expect(dispose).not.toHaveBeenCalled()
  })
})

type MarkPointDatum = { name: string, xAxis: number, yAxis: number, symbolSize?: number, label?: { formatter: () => string } }
type ReadingSeries = { markPoint?: { data: MarkPointDatum[] }, markLine?: { data: unknown[] } }

function readingSeries(): ReadingSeries {
  const series = (lastOption as { series: ReadingSeries[] }).series
  // The reading series is always last: comparing/trend, when drawn, sit ahead of it (Sparkline.tsx's
  // own comment on series order), and neither carries a markPoint of its own.
  return series.at(-1)!
}

describe('a sparkline with a labelled baseline band', () => {
  // NightCard.tsx (M9's redesign) hands the strip a shaded band with nothing beside it to say what
  // the shading means, unlike the mini figures next to it, which always name their own numbers. This
  // prop closes that gap: two labels anchored at the band's own low/high values, at the chart's right
  // edge, on the same series HeartRateRange and this chart already anchor their excluded marks to.
  it('draws the low and high text at the band edges via markPoint, never via markLine', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} />
        </I18nProvider>,
      )
    })
    const { markPoint, markLine } = readingSeries()
    const bandPoints = (markPoint?.data ?? []).filter((d) => d.yAxis === 8000 || d.yAxis === 9500)
    expect(bandPoints).toHaveLength(2)
    // Anchored at the last day's index, the chart's right edge, not at a fixed pixel position: a
    // pixel position could not follow the axis's own fitted extent, which the axis (scale: true,
    // no min/max of its own) recomputes from the data every time the range or the reading changes.
    expect(bandPoints.every((d) => d.xAxis === values.length - 1)).toBe(true)
    expect(bandPoints.map((d) => d.label!.formatter()).sort()).toEqual(['8,000', '9,500'])
    // No line drawn for these two: markLine is reserved for the dashed annotation verticals this
    // chart already draws (day marks), and a band-edge mark that borrowed it would inherit their
    // dashed styling and their excluded-day override.
    expect(markLine?.data).toEqual([])
  })

  it('adds no markPoint entries for the band when bandLabels is not given', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            baseline={{ low: 8000, high: 9500 }} />
        </I18nProvider>,
      )
    })
    const { markPoint } = readingSeries()
    expect((markPoint?.data ?? []).filter((d) => d.yAxis === 8000 || d.yAxis === 9500)).toEqual([])
  })
})
