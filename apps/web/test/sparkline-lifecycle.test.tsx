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
// The click listener useChart binds, kept so the day-opening suite below can click a point the way
// echarts would hand the event over.
let clickHandler: ((event: unknown) => void) | undefined
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: (name: string, fn: (event: unknown) => void) => { if (name === 'click') clickHandler = fn },
      setOption: (option: unknown) => { lastOption = option }, dispose, resize: vi.fn() }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  dispose.mockClear()
  lastOption = undefined
  clickHandler = undefined
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

// Sparkline.tsx's own fallback family string, duplicated here rather than imported: it is not
// exported, and this file's job is to pin the observable behaviour (what the band labels are
// actually painted in), not to reach into the module's internals to read the constant back out.
// This environment (happy-dom, and CHART_VARS above sets no --font-sans) always resolves to this
// fallback, never to a real --font-sans value, so the two staying in sync is a fact this suite can
// only assert by keeping the literal identical to Sparkline.tsx's own.
const FONT_FAMILY_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

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

type MarkPointDatum = { name: string, xAxis: number, yAxis: number, symbolSize?: number, label?: { formatter: () => string, position?: string, fontFamily?: string } }
type ReadingSeries = {
  markPoint?: { data: MarkPointDatum[] }
  markLine?: { data: unknown[] }
}
type Grid = { left?: number, right?: number }
type YAxis = { min?: (extent: { min: number, max: number }) => number, max?: (extent: { min: number, max: number }) => number }

function chartOption(): { grid: Grid, yAxis: YAxis } {
  return lastOption as { grid: Grid, yAxis: YAxis }
}

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
    // Anchored at day zero, the chart's left edge, not at a fixed pixel position: a pixel position
    // could not follow the axis's own fitted extent, which the axis (scale: true, no min/max of its
    // own beyond the band-widening below) recomputes from the data every time the range or the
    // reading changes. Anchored at the first day rather than the last so the low label never sits
    // beside the latest (today's) dot, where it used to read as today's own value.
    expect(bandPoints.every((d) => d.xAxis === 0)).toBe(true)
    expect(bandPoints.every((d) => d.label!.position === 'left')).toBe(true)
    expect(bandPoints.map((d) => d.label!.formatter()).sort()).toEqual(['8,000', '9,500'])
    // Both labels painted in the exact same family the margin was measured against (fix round 3):
    // zrender paints a label with no fontFamily of its own in a generic 'sans-serif', not the app's
    // own --font-sans, so a label missing this would size grid.left for a font nothing on screen is
    // actually set in. This environment (happy-dom, no CHART_VARS entry for --font-sans) resolves
    // the same fallback family measureLabelWidth's own canvas-less path measures characters against.
    expect(bandPoints.every((d) => d.label!.fontFamily === FONT_FAMILY_FALLBACK)).toBe(true)
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

  // Fix round 1 anchored the labels at the grid's left with a flat 40px margin; fix round 2 found
  // that flat number too narrow for a label like "11.590" or "7h 48m", which ran the text straight
  // into the first day's own dot and line. happy-dom (this file's environment) has no canvas 2D
  // context, so measureLabelWidth falls back to FALLBACK_CHAR_WIDTH (7.5px) per character - this is
  // the fallback path's own pin, not a canvas measurement.
  const FALLBACK_CHAR_WIDTH = 7.5
  const BAND_LABEL_GAP = 8
  function expectedMargin(low: string, high: string): number {
    return Math.ceil(Math.max(low.length, high.length) * FALLBACK_CHAR_WIDTH) + BAND_LABEL_GAP
  }

  // The margin sits on the grid's left, beside day zero, and never on the right, beside the latest
  // dot: a right margin left over from before this fix would still leave room for text nothing
  // draws there any more, and (worse) leave none on the left for the text that now does.
  it('sizes the grid\'s left margin to the label text, not the right, when bandLabels is set', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} />
        </I18nProvider>,
      )
    })
    const { grid } = chartOption()
    expect(grid.left).toBe(expectedMargin('8,000', '9,500'))
    expect(grid.right).not.toBe(grid.left)
  })

  // The defect fix round 1 shipped and fix round 2 caught in a screenshot: a flat margin fits some
  // labels and overruns others. "11.590" (6 characters) needs more room than "8,000" (5) did, and a
  // margin that stayed flat regardless of the text would touch or overlap the first dot for exactly
  // the labels this pins.
  it('grows the grid\'s left margin for a longer label', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            baseline={{ low: 5593, high: 11590 }} bandLabels={{ low: '5.593', high: '11.590' }} />
        </I18nProvider>,
      )
    })
    const { grid } = chartOption()
    expect(grid.left).toBe(expectedMargin('5.593', '11.590'))
  })

  // bandLabels alone, with no baseline to anchor the labels against: the markPoint data above only
  // ever draws the two edge labels under `bandLabels && baseline`, so a margin computed for
  // `bandLabels` alone would widen the grid for text this render never draws (NightCard's own
  // thin-baseline case: bandLabels stays undefined too here, but a caller could in principle hand
  // one without the other, and the margin has to agree with what markPoint actually draws either way).
  it('keeps the plain (non-label) grid margin when bandLabels is given but baseline is not', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
            bandLabels={{ low: '5.593', high: '11.590' }} />
        </I18nProvider>,
      )
    })
    const { grid } = chartOption()
    expect(grid.left).toBe(0)
  })

  // scale: true alone fits the y axis to the series values, and a markArea/markPoint never widens
  // that extent - so a band whose edge sits outside every day's own reading (every day below the
  // band's top, or above its bottom) got clipped along with its edge label. With a baseline, the
  // axis's min/max become functions that widen whatever extent echarts would otherwise have picked
  // to also cover both band edges.
  describe('the y axis widens to fit the band', () => {
    it('extends past the fitted extent on both sides when every value already sits inside the band', () => {
      act(() => {
        root!.render(
          <I18nProvider lng="en">
            <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
              baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} />
          </I18nProvider>,
        )
      })
      const { yAxis } = chartOption()
      expect(yAxis.min!({ min: 8600, max: 9400 })).toBe(8000)
      expect(yAxis.max!({ min: 8600, max: 9400 })).toBe(9500)
    })

    it('keeps the fitted extent\'s own edge when every value sits below the band', () => {
      act(() => {
        root!.render(
          <I18nProvider lng="en">
            <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
              baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} />
          </I18nProvider>,
        )
      })
      const { yAxis } = chartOption()
      // Every reading below the band (the steps strip's own reported defect): the fitted min is
      // already below the band's low, so the band's own low must not pull it back up, and the
      // fitted max sits below the band's high, so the max function must reach up to the band's top.
      expect(yAxis.min!({ min: 5000, max: 7000 })).toBe(5000)
      expect(yAxis.max!({ min: 5000, max: 7000 })).toBe(9500)
    })

    it('keeps the fitted extent\'s own edge when every value sits above the band', () => {
      act(() => {
        root!.render(
          <I18nProvider lng="en">
            <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026"
              baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} />
          </I18nProvider>,
        )
      })
      const { yAxis } = chartOption()
      expect(yAxis.min!({ min: 10000, max: 12000 })).toBe(8000)
      expect(yAxis.max!({ min: 10000, max: 12000 })).toBe(12000)
    })
  })

  it('leaves the y axis with no min/max override when there is no baseline to widen for', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026" />
        </I18nProvider>,
      )
    })
    const { yAxis } = chartOption()
    expect(yAxis.min).toBeUndefined()
    expect(yAxis.max).toBeUndefined()
  })
})

// M9c: the dashboard's strips open the day a dot stands for. The tooltip ends with the words for
// that ("Open this day") only when a click would do it, which is never on the day already shown.
describe('a strip whose dots open their day', () => {
  const OPENS = { current: '2026-08-12', tail: 'Open this day', idle: 'Tap a day to open it', named: (name: string) => `Open ${name}` }

  function renderStrip(props: { onPointClick?: (date: string) => void, opensDay?: typeof OPENS }) {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026" dots
            formatValue={(v, absent) => (v === null ? absent : String(v))} {...props} />
        </I18nProvider>,
      )
    })
  }
  function tooltip(dataIndex: number): string {
    const formatter = (lastOption as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter
    return formatter([{ componentType: 'series', dataIndex }])
  }

  it('ends the tooltip with the open line on every day but the one shown', () => {
    renderStrip({ onPointClick: vi.fn(), opensDay: OPENS })
    expect(tooltip(0)).toBe('2026-08-10<br/>Steps: 9000<br/>Open this day')
    expect(tooltip(1)).toBe('2026-08-11<br/>Steps: 8600<br/>Open this day')
    expect(tooltip(2)).toBe('2026-08-12<br/>Steps: 9400')
  })

  it('leaves the tooltip exactly as dayTooltip writes it without the prop', () => {
    renderStrip({ onPointClick: vi.fn() })
    expect(tooltip(0)).toBe('2026-08-10<br/>Steps: 9000')
  })

  it('opens a clicked day, and not the day already shown', () => {
    const open = vi.fn()
    renderStrip({ onPointClick: open, opensDay: OPENS })
    act(() => { clickHandler!({ componentType: 'series', dataIndex: 0 }) })
    expect(open.mock.calls).toEqual([['2026-08-10']])
    act(() => { clickHandler!({ componentType: 'series', dataIndex: 2 }) })
    expect(open.mock.calls).toEqual([['2026-08-10']])
  })
})

// The dashboard's strips judge every dot against its own day's usual (GlanceStripDay.band), so the
// band behind the strip steps day by day: each day's slot shaded from its own low to its own high,
// the band the dot's colour was judged against, rather than one band for the whole week.
describe('a sparkline with a band per day', () => {
  type CustomSeries = { type: string, markArea?: unknown, silent?: boolean, z?: number, data: number[][], renderItem: (p: unknown, api: unknown) => { shape: { x: number, y: number, width: number, height: number } } }
  const series = () => (lastOption as { series: ({ type: string, markArea?: unknown } | CustomSeries)[] }).series

  function renderBands(bands: ({ low: number, high: number } | null)[]) {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026" dots
            baseline={{ low: 8000, high: 9500 }} bandLabels={{ low: '8,000', high: '9,500' }} bands={bands} />
        </I18nProvider>,
      )
    })
  }

  it('draws one step per day with a band, at that day\'s own low and high, and leaves a null day unshaded', () => {
    renderBands([{ low: 7000, high: 8800 }, null, { low: 8000, high: 9500 }])
    const steps = series().find((s) => s.type === 'custom') as CustomSeries
    expect(steps.data).toEqual([[0, 7000, 8800], [2, 8000, 9500]])
    // Shading, beneath the line and dots, never a point to hover or open.
    expect(steps.silent).toBe(true)
    expect(steps.z).toBeLessThan(2)
    // Replaces the one band across the whole strip rather than drawing both.
    expect(series().find((s) => s.type === 'line')!.markArea).toBeUndefined()
    // The labels still name the day shown, the last step, as the card's own "usual" words do.
    const line = series().find((s) => s.type === 'line') as unknown as ReadingSeries
    expect((line.markPoint?.data ?? []).filter((d) => d.name.startsWith('band-')).map((d) => d.yAxis).sort()).toEqual([8000, 9500])
  })

  it('shades each step across its whole slot, centred on the day, meeting its neighbour on one pixel', () => {
    renderBands([{ low: 7000, high: 8800 }, { low: 7500, high: 9000 }, { low: 8000, high: 9500 }])
    const steps = series().find((s) => s.type === 'custom') as CustomSeries
    // A fake 3-slot grid, 100.4px a slot: day i's centre at 50.2 + 100.4i, y = value / 10 upside down.
    const slot = 100.4
    const api = (datum: number[]) => ({
      value: (d: number) => datum[d],
      coord: ([x, y]: number[]) => [slot / 2 + x! * slot, 1000 - y! / 10],
      size: () => [slot, 0],
    })
    const rects = steps.data.map((datum) => steps.renderItem({}, api(datum)).shape)
    expect(rects[0]).toEqual({ x: 0, y: 1000 - 880, width: 100, height: 180 })
    expect(rects.map((r) => r.x + r.width)).toEqual([100, 201, 301])
    expect(rects.slice(1).map((r) => r.x)).toEqual([100, 201])
  })

  it('draws the single band exactly as before when no bands are given', () => {
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <Sparkline values={values} labels={labels} metric="steps" unit="Steps" label="steps, august 2026" dots
            baseline={{ low: 8000, high: 9500 }} />
        </I18nProvider>,
      )
    })
    expect(series().some((s) => s.type === 'custom')).toBe(false)
    expect(series().find((s) => s.type === 'line')!.markArea).toBeDefined()
  })
})
