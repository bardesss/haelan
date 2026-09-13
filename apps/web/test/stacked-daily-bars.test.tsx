// @vitest-environment happy-dom
//
// happy-dom and a mocked echarts/core, the same shape chart-marks.test.tsx uses and for the same
// reason: the option object handed to setOption is the only part of a chart a test here can read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { StackedDailyBars } from '../src/charts/StackedDailyBars.js'
import type { BandSeries } from '../src/charts/StackedDailyBars.js'
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

const labels = ['2026-08-16', '2026-08-17']

const FOUR: BandSeries[] = [
  { key: 'light', name: 'Light', values: [10, 4] },
  { key: 'moderate', name: 'Moderate', values: [5, 0] },
  { key: 'vigorous', name: 'Vigorous', values: [5, 2] },
  { key: 'peak', name: 'Peak', values: [3, 0] },
]

function mount(props: Partial<Parameters<typeof StackedDailyBars>[0]> = {}) {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <StackedDailyBars series={FOUR} labels={labels} metric="active_minutes_light"
          label="active minutes, august 2026" unit="Minutes" axisUnit="min" {...props} />
      </I18nProvider>,
    )
  })
  const stub = chartStubs.at(-1)!
  return stub.setOption.mock.calls[0]![0] as {
    series: { type?: string, stack?: string, name?: string, data?: unknown[] }[]
  }
}

it('draws every band as one stack', () => {
  const option = mount()
  expect(option.series).toHaveLength(4)
  for (const series of option.series) {
    expect(series.type).toBe('bar')
    // One stack id across all four, which is what makes them add rather than overlap.
    expect(series.stack).toBe(option.series[0]!.stack)
    expect(series.stack).toBeTruthy()
  }
})

it('keeps each band\'s values in the order it was given them', () => {
  const option = mount()
  expect(option.series.map((s) => s.name)).toEqual(['Light', 'Moderate', 'Vigorous', 'Peak'])
  expect(option.series[0]!.data).toEqual([10, 4])
})

it('clamps a negative band to zero', () => {
  // A negative band is the visible signature of the page's subtraction going wrong. Drawing it
  // below the axis would render the defect as though it were data.
  const option = mount({ series: [{ key: 'light', name: 'Light', values: [-3, 5] }] })
  expect(option.series[0]!.data).toEqual([0, 5])
})

it('carries a null through as a gap rather than a zero', () => {
  const option = mount({ series: [{ key: 'light', name: 'Light', values: [null, 5] }] })
  expect(option.series[0]!.data).toEqual([null, 5])
})
