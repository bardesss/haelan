// @vitest-environment happy-dom
//
// happy-dom and a mocked echarts/core, the same shape chart-marks.test.tsx uses and for the same
// reason: the option object handed to setOption is the only part of a chart a test here can read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { DailyBars } from '../src/charts/DailyBars.js'
import { CHART_VARS } from '../src/charts/tokens.js'

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

function chartStub() {
  return { on: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }
}
const chartStubs: ReturnType<typeof chartStub>[] = []

vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => { const stub = chartStub(); chartStubs.push(stub); return stub },
  }
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

const labels = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']
const values = [9_200_000, null, 8_600_000, 7_100_000]

// Distance is stored in millimetres and displayed in kilometres, which is the whole reason the
// axis cannot read the raw array. The same formatter Activity.tsx hands its distance card.
const km = (value: number | null, absent: string): string =>
  value === null ? absent : (value / 1_000_000).toFixed(1)

/** The function useChart.ts actually passed to `chart.on('click', ...)`, i.e. `handleClick`. Same
 *  idiom chart-marks.test.tsx's own `clickHandlerOf` uses for Sparkline/ActivityHeatmap/HeartRateRange. */
function clickHandlerOf(stub: ReturnType<typeof chartStub>): (event: unknown) => void {
  const call = stub.on.mock.calls.find(([event]) => event === 'click')
  if (!call) throw new Error('chart.on was never called with "click"')
  return call[1] as (event: unknown) => void
}

function mount(props: Partial<Parameters<typeof DailyBars>[0]> = {}) {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <DailyBars values={values} labels={labels} metric="distance" label="distance, august 2026"
          unit="Distance in kilometers" axisUnit="km" formatValue={km}
          annotations={[]} excluded={[]} {...props} />
      </I18nProvider>,
    )
  })
  const stub = chartStubs.at(-1)!
  return stub.setOption.mock.calls[0]![0] as {
    yAxis: { min?: number, scale?: boolean, name?: string, minInterval?: number, axisLabel?: { formatter?: (v: number) => string } },
    xAxis: { data?: unknown[], axisLabel?: { interval?: number } },
    series: { type?: string, data?: unknown[], markPoint?: { data?: unknown[] }, markLine?: { data?: unknown[] } }[],
  }
}

describe('DailyBars', () => {
  // The rule most likely to be "optimised" away by someone noticing the bars are short and the
  // axis mostly empty. A bar's length IS its value, so an axis that does not start at zero
  // misstates the ratio between two days; Sparkline's own `scale: true` is correct for a line and
  // wrong here, which is exactly how it would get copied across.
  it('starts its value axis at zero and never fits it to the data', () => {
    const option = mount()
    expect(option.yAxis.min).toBe(0)
    expect(option.yAxis.scale).toBeUndefined()
  })

  it('draws one bar per day, in the order the labels give', () => {
    const option = mount()
    expect(option.series[0]!.type).toBe('bar')
    expect(option.series[0]!.data).toEqual(values)
  })

  // The unit seam. `values` stay in the stored unit (millimetres), so an axis reading them raw
  // prints 9,200,000 under a card headed in kilometres - the defect an M3e review already caught
  // once in the accessible table.
  it('labels the value axis through the caller\'s own formatter', () => {
    const option = mount()
    expect(option.yAxis.axisLabel!.formatter!(9_200_000)).toBe('9.2')
    expect(option.yAxis.name).toBe('km')
  })

  // Finding 1 of the whole-branch review: echarts picks tick steps off the STORED scale and the
  // axis label runs the DISPLAY formatter, so nothing stops a tick step finer than the formatter
  // can resolve. Floors at a small range ticked at half-floor steps and the shared formatter (no
  // fractional floor to show) printed "0 | 0 | 0 | 1 | 1 | 1", three gridlines all labelled zero.
  // The caller, not this chart, knows what its own formatter can tell apart, so this prop is
  // handed straight to `yAxis.minInterval` rather than derived from the catalogue's precision.
  it('passes the caller\'s minInterval straight to the value axis', () => {
    expect(mount({ minInterval: 1 }).yAxis.minInterval).toBe(1)
  })

  it('leaves the value axis minInterval unset when the caller does not pass one', () => {
    expect(mount().yAxis.minInterval).toBeUndefined()
  })

  it('thins the date labels by the point count', () => {
    expect(mount().xAxis.axisLabel!.interval).toBe(0)
    expect(mount({ values: Array.from({ length: 30 }, () => 1), labels: Array.from({ length: 30 }, (_, i) => `2026-08-${i + 1}`) })
      .xAxis.axisLabel!.interval).toBe(4)
  })

  // The regression to guard: these two cards have had exclusions and notes since M3c, and a
  // promoted card that quietly lost them would be a feature that took one away.
  it('keeps the excluded mark and the annotation mark', () => {
    const option = mount({ excluded: ['2026-08-13'], annotations: [{ date: '2026-08-11', text: 'travelling' }] })
    expect(option.series[0]!.markPoint!.data).toHaveLength(1)
    expect(option.series[0]!.markLine!.data).toHaveLength(1)
  })

  it('renders the accessible table its figure carries', () => {
    mount()
    expect(container!.querySelector('table')).not.toBeNull()
    expect(container!.textContent).toContain('2026-08-10')
  })

  // The wiring, not the pure function `dayPointDate` already covers on its own (chart-marks.test.tsx):
  // that a real click reaching this chart's own handler actually calls back with the right date.
  it('reports the label at the bar a genuine click landed on', () => {
    const onPointClick = vi.fn()
    mount({ onPointClick })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', dataIndex: 2 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-12')
  })
})
