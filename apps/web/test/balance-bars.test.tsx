// @vitest-environment happy-dom
//
// happy-dom and a mocked echarts/core, the same shape daily-bars.test.tsx uses and for the same
// reason: the option object handed to setOption is the only part of a chart a test here can read,
// because echarts draws to a canvas no assertion in this environment can inspect.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { BalanceBars } from '../src/charts/BalanceBars.js'
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
// A surplus night, a night the watch missed, a deficit night, and a second surplus. Dense over the
// range, the shape every by-day chart on the Sleep page is handed.
const values = [45, null, -105, 30]

type AxisOption = {
  min?: number
  max?: number
  splitNumber?: number
  scale?: boolean
  name?: string
  axisLabel?: { formatter?: (v: number) => string }
}

type Option = {
  yAxis: AxisOption
  xAxis: { data?: unknown[], axisLabel?: { interval?: number } }
  series: {
    type?: string
    data?: unknown[]
    itemStyle?: { color?: string | ((params: { value?: unknown }) => string) }
    markPoint?: { data?: unknown[] }
    markLine?: { data?: unknown[] }
  }[]
}

function mount(props: Partial<Parameters<typeof BalanceBars>[0]> = {}): Option {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <BalanceBars values={values} labels={labels} label="balance, august 2026"
          unit="Minutes over or under"
          annotations={[]} excluded={[]} {...props} />
      </I18nProvider>,
    )
  })
  const stub = chartStubs.at(-1)!
  return stub.setOption.mock.calls[0]![0] as Option
}

/** The function useChart.ts actually passed to `chart.on('click', ...)`, i.e. `handleClick`. */
function clickHandlerOf(stub: ReturnType<typeof chartStub>): (event: unknown) => void {
  const call = stub.on.mock.calls.find(([event]) => event === 'click')
  if (!call) throw new Error('chart.on was never called with "click"')
  return call[1] as (event: unknown) => void
}

const tableRowFor = (date: string): string[] | undefined =>
  [...container!.querySelectorAll('table tbody tr')]
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''))
    .find((cells) => cells[0] === date)

describe('BalanceBars', () => {
  // The whole reason this is a second component rather than a flag on DailyBars: half of these
  // bars are negative by construction, so `min: 0` would draw a night two hours under its target
  // as a bar of length zero. Asserted as a centered extent rather than as the mere absence of
  // the literal, because a chart that simply left the axis to echarts would pass the absence
  // while still fitting whatever the data happened to span.
  it('centers its value axis on the zero line rather than starting it at zero', () => {
    const option = mount()
    expect(option.yAxis.min).toBeLessThan(0)
    expect(option.yAxis.min).toBe(-option.yAxis.max!)
  })

  // The extent is the peak deviation rounded up to the half hour: the axis ticks the minimum,
  // zero and the maximum (splitNumber below), and an unfitted extent would tick at whatever
  // the data's own extremes happen to be. Peak here is 105, so the half extent is 120.
  it('fits a symmetric half-hour extent around the zero line', () => {
    const option = mount()
    expect(option.yAxis.min).toBe(-120)
    expect(option.yAxis.max).toBe(120)
    expect(option.yAxis.splitNumber).toBe(2)
  })

  // The other side of the same decision, reversed: a period with nothing under the line keeps
  // the line centered with empty space below it, because the line is the comparison every bar
  // is measured against rather than the data's own floor. Peak here is 45, so the half extent
  // is the one-hour floor.
  it('keeps the zero line centered when every readable night is at or above it', () => {
    const option = mount({ values: [45, null, 10, 30] })
    expect(option.yAxis.min).toBe(-60)
    expect(option.yAxis.max).toBe(60)
  })

  // The zero line is the comparison, and it is drawn as a markLine because echarts puts value
  // axis ticks wherever the extent it fitted happens to place them. Without it a reader sees bars
  // of two colours and no statement of what they are measured from.
  it('draws the zero line as its own dashed mark at zero', () => {
    const marks = mount().series[0]!.markLine!.data as { name?: string, yAxis?: number }[]
    expect(marks.at(-1)!.name).toBe('zero')
    expect(marks.at(-1)!.yAxis).toBe(0)
  })

  it('draws one bar per day, in the order the labels give, with null still in place', () => {
    const option = mount()
    expect(option.series[0]!.type).toBe('bar')
    // The null is the point: dropping it would shift every later night one day to the left.
    expect(option.series[0]!.data).toEqual([45, null, -105, 30])
  })

  // Sign is carried by colour as well as by which side of the line the bar sits on, so the two
  // have to agree. The two tokens are pinned to distinguishable values for the length of this test
  // rather than left at the loop's own '#000000': with every token the same colour, a chart that
  // coloured every bar with one arm would pass an assertion written against the shared value.
  it('colours a bar by its own sign', () => {
    document.documentElement.style.setProperty('--chart-balance-over', '#111111')
    document.documentElement.style.setProperty('--chart-balance-under', '#222222')
    try {
      const color = mount().series[0]!.itemStyle!.color as (params: { value?: unknown }) => string
      expect(color({ value: 45 })).toBe('#111111')
      expect(color({ value: -105 })).toBe('#222222')
      // At the line is not below it, and the two claims have to agree with the bar's own direction.
      expect(color({ value: 0 })).toBe('#111111')
    } finally {
      document.documentElement.style.setProperty('--chart-balance-over', '#000000')
      document.documentElement.style.setProperty('--chart-balance-under', '#000000')
    }
  })

  // The axis labels are deviations, not clock times: with a rolling baseline there is no absolute
  // "8h" gridline to label, and formatSignedDuration is what keeps a negative tick from printing
  // two minus signs (format.ts).
  it('labels the value axis as a signed deviation', () => {
    const option = mount()
    expect(option.yAxis.axisLabel!.formatter!(-105)).toBe('-1h 45m')
    expect(option.yAxis.axisLabel!.formatter!(45)).toBe('45m')
  })

  it('states a signed balance per readable night in its accessible table', () => {
    mount()
    expect(tableRowFor('2026-08-10')).toEqual(['2026-08-10', '45m', ''])
    expect(tableRowFor('2026-08-12')).toEqual(['2026-08-12', '-1h 45m', ''])
  })

  // Absent is never a zero. A night with no reading is a cell the table names rather than a row it
  // drops or a value it invents, which is the same rule the card's own headline obeys.
  it('states no reading for a silent night rather than a balance of zero', () => {
    mount()
    const row = tableRowFor('2026-08-11')
    expect(row).toBeDefined()
    expect(row![1]).toBe('no reading')
    expect(row![1]).not.toMatch(/^(0h 00m|0m)$/)
  })

  // A night the reader excluded is a different sentence from one the device never reported, and
  // the canvas has to say the same thing: dayMarks moves a valueless excluded day to `atDate`,
  // where it is drawn by position, so the two channels agree instead of one showing a silent gap.
  it('names an excluded night in the table and marks it on the canvas', () => {
    const option = mount({ excluded: ['2026-08-11'] })
    expect(tableRowFor('2026-08-11')![1]).toBe('excluded')
    // The excluded day's own mark, then the zero line last.
    expect(option.series[0]!.markLine!.data).toHaveLength(2)
  })

  it('keeps a note on the canvas and in the table', () => {
    const option = mount({ annotations: [{ date: '2026-08-13', text: 'travelling' }] })
    expect(option.series[0]!.markLine!.data).toHaveLength(2)
    expect(tableRowFor('2026-08-13')![2]).toBe('travelling')
  })

  it('thins the date labels by the point count', () => {
    expect(mount().xAxis.axisLabel!.interval).toBe(0)
  })

  it('reports the label at the bar a genuine click landed on', () => {
    const onPointClick = vi.fn()
    mount({ onPointClick })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', dataIndex: 2 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-12')
  })

  // A click on the zero line has no day behind it, and must not be reported as one: the zero line
  // rides in the same markLine array as the annotations and therefore counts into its dataIndex,
  // which is why it sits last there, past the end of marks.atDate, so markClickDate's optional
  // lookup resolves it to undefined. With no annotations atDate is empty and any order passes,
  // so this mounts with a mark present: dataIndex 0 is then the mark itself and only the last
  // index is the zero line.
  it('reports nothing for a click on the zero line', () => {
    const onPointClick = vi.fn()
    mount({ onPointClick, annotations: [{ date: '2026-08-13', text: 'travelling' }] })
    // One annotation mark plus the zero line last.
    clickHandlerOf(chartStubs.at(-1)!)({ componentType: 'markLine', dataIndex: 1 })
    expect(onPointClick).not.toHaveBeenCalled()
  })

  it('resolves an annotation mark to its own date rather than its neighbour', () => {
    const onPointClick = vi.fn()
    mount({ onPointClick, annotations: [{ date: '2026-08-13', text: 'travelling' }] })
    clickHandlerOf(chartStubs.at(-1)!)({ componentType: 'markLine', dataIndex: 0 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-13')
  })

  // The defect chart-annotate-handlers.test.tsx exists for, asserted here too because this is the
  // seventh chart to declare an optional `onPointClick`: useChart is handed `{ onClick, describe }`
  // only when the caller has somewhere to send a click, so a chart with no handler does not render
  // a control that arms itself on a tap and then does nothing. Registered in that file's own list
  // as well, where the same claim is made of all seven together rather than one at a time.
  it('renders no annotate control when the caller has nowhere to send a click', () => {
    mount()
    expect(container!.querySelector('.chart-annotate')).toBeNull()
  })
})
