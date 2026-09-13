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
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: vi.fn(), setOption: vi.fn(), dispose, resize: vi.fn() }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  dispose.mockClear()
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
