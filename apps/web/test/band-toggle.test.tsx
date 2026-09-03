// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because this file clicks a real button and reads
// the DOM back afterwards (createRoot + act), the same reason rail-collapse.test.tsx needs it.
// useChart's own effect runs echarts.init on mount regardless of what this file is asserting, so
// echarts/core is mocked the same way chart-marks.test.tsx mocks it: a real click handler wiring
// with no zrender hit-testing, which this file never exercises anyway.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { HeartRateRange } from '../src/charts/HeartRateRange.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { DayRow } from '../src/fixtures/july.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason chart-marks.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }),
  }
})

const days: DayRow[] = [
  { date: '2026-08-10', steps: 9000, hrMin: 54, hrMean: 68, hrMax: 121, sleepMinutes: 420, worn: true },
  { date: '2026-08-11', steps: 8600, hrMin: 52, hrMean: 66, hrMax: 118, sleepMinutes: 410, worn: true },
  { date: '2026-08-12', steps: 9400, hrMin: 55, hrMean: 70, hrMax: 124, sleepMinutes: 430, worn: true },
]

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

// Mounts HeartRateRange inside a real I18nProvider, the same shape rail-collapse.test.tsx's own
// mount uses for a control that flips one piece of state. `toggle` finds the control by its role
// rather than by a class name: this component renders nothing else that is a button, so a plain
// button lookup is unambiguous and does not couple the test to a class name the component is free
// to rename.
function mountChart(lng = 'en'): { container: HTMLDivElement; toggle: () => HTMLElement } {
  act(() => {
    root!.render(
      <I18nProvider lng={lng}>
        <HeartRateRange days={days} annotations={[]} excluded={[]} label="heart rate range" />
      </I18nProvider>,
    )
  })
  return {
    container: container!,
    toggle: () => {
      const el = container!.querySelector('button')
      if (!el) throw new Error('no band toggle button found')
      return el
    },
  }
}

describe('the min/max band toggle', () => {
  // Hiding the band must hide the table's minimum and maximum columns too, not only their pixels.
  // A screen reader user toggling this gets the same change a sighted one does, which is the whole
  // reason the series and the columns are driven from one piece of state.
  it('drops the minimum and maximum columns from the table when the band is off', () => {
    const { container, toggle } = mountChart()
    expect(container.textContent).toContain('Minimum')
    expect(container.textContent).toContain('Maximum')

    act(() => { toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(container.textContent).not.toContain('Minimum')
    expect(container.textContent).not.toContain('Maximum')
    expect(container.textContent, 'the mean is not part of the band').toContain('Mean')
  })

  // Shown by default, which is today's behaviour, so this control adds a way to hide something
  // rather than changing what a first visit looks like.
  it('shows the band before anything is clicked', () => {
    const { container } = mountChart()
    expect(container.textContent).toContain('Minimum')
  })

  // no-hardcoded-strings.test.ts reads text between tags, not an attribute, so an English label on
  // this control would sit on a Dutch page unseen. That is the defect the Dutch sweep found in the
  // stepper, and this is the same shape.
  it('names the control in the page language rather than in English', () => {
    const { toggle } = mountChart('nl')
    const name = toggle().getAttribute('aria-label') ?? toggle().textContent ?? ''
    expect(name).not.toBe('')
    expect(name, 'the Dutch label is missing or left in English').not.toMatch(/band/i)
  })
})
