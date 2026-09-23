// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import * as echarts from 'echarts'
import { Hypnogram, clockHours } from '../src/charts/Hypnogram.js'
import { hypnogramTooltip } from '../src/charts/hypnogramTooltip.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason chart-lifecycle.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
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

const MIN = 60_000
// A night from 00:40 (bed minute 40 of the wake date) running 6h 20m, in three pieces.
const SEGMENTS = [
  { stage: 'light' as const, startMs: 0, endMs: 90 * MIN },
  { stage: 'deep' as const, startMs: 90 * MIN, endMs: 170 * MIN },
  { stage: 'rem' as const, startMs: 170 * MIN, endMs: 380 * MIN },
]

type Axis = {
  min?: number, max?: number,
  axisTick?: { customValues?: number[] },
  axisLabel?: { customValues?: number[], formatter?: (v: number) => string },
}

function xAxisOf(startClock: number | null): Axis {
  act(() => {
    root!.render(<I18nProvider lng="en">
      <Hypnogram segments={SEGMENTS} startLabel="Bed 00:40" label="stages" startClock={startClock} />
    </I18nProvider>)
  })
  const host = container!.querySelector<HTMLDivElement>('div[role="img"]')
  expect(host, container!.innerHTML).not.toBeNull()
  const option = echarts.getInstanceByDom(host!)?.getOption() as { xAxis?: Axis[] } | undefined
  return option!.xAxis![0]!
}

// The old axis plotted minutes since bed and let ECharts choose its ticks, so a 00:40 bed time
// printed "0h 1h 3h 5h 6h": ticks every 100 minutes, floored to hours. On clock time the ticks
// must fall on whole hours of the clock and read as clock times.
describe('the hypnogram axis', () => {
  // The ticks are handed over explicitly rather than left to an interval. An interval counts from
  // the axis minimum, which is what the first version of this change got wrong on a real night:
  // a 22:54 bed time ticked 23:54, 00:54, 01:54.
  it('plots clock minutes from the bed time, ticking on whole hours', () => {
    const axis = xAxisOf(40)
    expect(axis.min).toBe(40)
    expect(axis.max).toBe(40 + 380)
    expect(axis.axisTick!.customValues).toEqual([60, 120, 180, 240, 300, 360])
    expect(axis.axisLabel!.customValues).toEqual(axis.axisTick!.customValues)
    expect(axis.axisLabel!.customValues!.map((v) => axis.axisLabel!.formatter!(v)))
      .toEqual(['01:00', '02:00', '03:00', '04:00', '05:00', '06:00'])
  })

  it('reads a bed time before midnight across it, still on the hour', () => {
    // 23:54, in the convention where a bed time before the wake date's midnight is negative.
    const axis = xAxisOf(-6)
    expect(axis.min).toBe(-6)
    expect(axis.axisLabel!.customValues!.map((v) => axis.axisLabel!.formatter!(v)))
      .toEqual(['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00'])
  })

  it('falls back to elapsed hours when the bed time was never recorded', () => {
    const axis = xAxisOf(null)
    expect(axis.min).toBe(0)
    expect(axis.axisLabel!.formatter!(120)).toBe('2h')
  })
})

describe('clockHours', () => {
  it('lists the whole hours strictly inside the span', () => {
    expect(clockHours(40, 420)).toEqual([60, 120, 180, 240, 300, 360])
    // A night starting on the hour does not tick its own start; the bed label names it.
    expect(clockHours(60, 240)).toEqual([120, 180])
  })

  it('handles a start before midnight', () => {
    expect(clockHours(-50, 130)).toEqual([0, 60, 120])
  })

  it('steps every second hour past ten hours, so the labels keep their room', () => {
    expect(clockHours(-120, 600)).toEqual([0, 120, 240, 360, 480])
  })
})

describe('the hypnogram tooltip', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    key === 'charts.hypnogramTooltip.span' ? `${String(options?.from)} to ${String(options?.to)}`
      : `${String(options?.label)}: ${String(options?.value)}`) as never

  it('says clock times when the axis does', () => {
    expect(hypnogramTooltip(SEGMENTS, 1, t, 40)).toContain('02:10 to 03:30')
  })

  it('keeps elapsed time without a known start', () => {
    expect(hypnogramTooltip(SEGMENTS, 1, t)).toContain('1h 30m to 2h 50m')
  })
})
