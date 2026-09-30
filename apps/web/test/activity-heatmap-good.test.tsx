// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { ActivityHeatmap } from '../src/charts/ActivityHeatmap.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { DayRow } from '../src/fixtures/july.js'
import { I18nProvider } from '../src/i18n/index.js'

// The good day's mark on the steps heatmap (PATTERNS.md's "Overview pages": a ring on its cell, ✦ in
// text): the option echarts is handed, read off a stubbed init, and the accessible table beside it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const { options } = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }))
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: vi.fn(), setOption: (o: Record<string, unknown>) => { options.push(o) }, dispose: vi.fn(), resize: vi.fn() }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null
beforeEach(() => {
  options.length = 0
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

const day = (date: string, steps: number | null): DayRow => ({ date, steps, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: steps !== null })
// A Monday to Wednesday: weeks column 0, weekdays rows 0 to 2.
const DAYS = [day('2026-07-06', 4000), day('2026-07-07', 9000), day('2026-07-08', 5000)]

function mount(good: string | null) {
  act(() => {
    root!.render(<I18nProvider lng="en"><ActivityHeatmap days={DAYS} max={9000} label="Steps per day" good={good} /></I18nProvider>)
  })
  type Series = { type: string, silent?: boolean, data: unknown[], itemStyle?: { borderColor?: string } }
  return { series: (options.at(-1)!.series as Series[]), rows: [...container!.querySelectorAll('table tbody tr')] }
}

describe('ActivityHeatmap: a good day', () => {
  it('rings the good day\'s cell alone, silent, and marks its table row ✦', () => {
    const { series, rows } = mount('2026-07-07')
    const rings = series.filter((s) => s.silent === true)
    expect(rings).toHaveLength(1)
    expect(rings[0]!.data).toEqual([[0, 1]])
    expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(['', '✦', ''])
  })

  it('draws no ring and no ✦ without a good day', () => {
    const { series, rows } = mount(null)
    expect(series.filter((s) => s.silent === true)).toHaveLength(0)
    expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(['', '', ''])
  })
})
