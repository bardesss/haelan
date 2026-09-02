// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: the index-positioning tests below need a real
// mount (createRoot + act) so useChart's own useEffect actually runs and calls echarts.init. The
// accessible-table test still uses renderToStaticMarkup, which runs no effects and so never
// touches echarts at all regardless of which environment the file runs under, the same split
// chart-marks.test.tsx documents for its own three charts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { Spo2Range } from '../src/charts/Spo2Range.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { Spo2Day } from '../src/charts/Spo2Range.js'
import { I18nProvider } from '../src/i18n/index.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason chart-marks.test.tsx and chart-lifecycle.test.tsx set them. Needed even
// though echarts.init itself is mocked below: build(currentChartTokens()) still runs before the
// mocked setOption ever sees its argument.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance useChart.ts creates, the same stub chart-marks.test.tsx
 * uses for its own wiring tests, so `setOption`'s own argument (the only place a mark's placement
 * can be read from under happy-dom, per this task's own note that a chart cannot be asserted by
 * rendering and hovering) can be captured without a real canvas.
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

it('names the day, the interval and the reading count in its accessible table', () => {
  const days: Spo2Day[] = [
    { date: '2026-08-14', min: 94, mean: 96.4, max: 99, count: 412 },
    { date: '2026-08-15', min: null, mean: null, max: null, count: null },
  ]
  // Wrapped in I18nProvider(lng="en"), unlike chart-marks.test.tsx's own no-provider convention:
  // that convention exists so a table cell can be asserted against a translation KEY rather than
  // copy a locale file is free to reword, which is not what this test does. This test's own
  // '96.4' is a formatted NUMBER, and formatMetricValue's toLocaleString reads i18n.language to
  // decide the decimal separator; with no provider mounted, react-i18next's global instance is
  // never initialised, i18n.language is undefined, and toLocaleString(undefined) falls back to
  // this machine's own OS locale (Dutch on the author's own machine, comma decimal), which would
  // make this exact literal fail for a reason that has nothing to do with the component. Pinning
  // the language the same way the real app does everywhere (I18nProvider at the root) is what
  // makes '96.4' a fact about the component rather than about whichever machine runs the suite.
  const html = renderToStaticMarkup(
    <I18nProvider lng="en">
      <Spo2Range days={days} label="SpO2" annotations={[]} excluded={[]} />
    </I18nProvider>,
  )
  const table = html.match(/<table class="sr-only">[\s\S]*?<\/table>/)![0]
  expect(table).toContain('2026-08-14')
  expect(table).toContain('96.4')
  // The exact cell, not `toContain('412')`: formatNumber(412, 0, ...) and formatMetricValue(412,
  // 'spo2', ...) (precision 1) both render a string that CONTAINS "412" ("412" and "412.0"), so a
  // substring check alone cannot tell the count's own precision-0 formatter apart from spo2's
  // precision-1 one and stays green under either mistake. The count column is a genuine integer
  // agg (packages/core/src/derive/metrics.ts, spo2's own `count`), never spo2's precision, and this
  // is the one place a precision mix-up between the two would actually go red.
  expect(table).toContain('<td>412</td>')
  expect(table).toContain('2026-08-15')
})

describe('mark positioning across a month boundary', () => {
  // Six days crossing August into September, an excluded day early in the range (still carrying
  // its value, the window before the derive catches up, so it draws as a markPoint) and an
  // annotation on a day in the second month (so it draws as a markLine). M3c's own Critical was
  // HeartRateRange placing a mark's `xAxis` with `date.slice(8)`, a day-of-month label a category
  // axis's markPoint/markLine `xAxis` resolves by NAME against the axis's own labels; two visible
  // days on either side of a month boundary can share that label; and a category axis's `xAxis`
  // given as a plain number instead names a POSITION, which cannot collide. Every mark below must
  // be a number for exactly that reason.
  const sixDays: Spo2Day[] = [
    { date: '2026-08-29', min: 93, mean: 96, max: 99, count: 400 },
    { date: '2026-08-30', min: 92, mean: 95, max: 98, count: 401 },
    { date: '2026-08-31', min: 94, mean: 97, max: 100, count: 402 },
    { date: '2026-09-01', min: 91, mean: 94, max: 97, count: 403 },
    { date: '2026-09-02', min: 95, mean: 98, max: 101, count: 404 },
    { date: '2026-09-03', min: 90, mean: 93, max: 96, count: 405 },
  ]

  function meanSeriesOf(): { markPoint?: { data: Record<string, unknown>[] }, markLine?: { data: Record<string, unknown>[] } } {
    const stub = chartStubs.at(-1)!
    const option = stub.setOption.mock.calls[0]![0] as { series: Record<string, never>[] }
    return option.series[2]! as never
  }

  it('resolves both the excluded markPoint and the annotation markLine to a numeric array index', () => {
    act(() => {
      root!.render(
        <Spo2Range days={sixDays} excluded={['2026-08-30']}
          annotations={[{ date: '2026-09-02', text: 'felt breathless' }]} label="SpO2" />,
      )
    })
    const meanSeries = meanSeriesOf()
    // index 1: 2026-08-30, still carrying its mean, so dayMarks places it in atValue.
    expect(meanSeries.markPoint?.data).toEqual([{ name: 'excluded', xAxis: 1, yAxis: 95 }])
    // index 4: 2026-09-02, the second month's day.
    expect(meanSeries.markLine?.data).toEqual([{ name: 'felt breathless', xAxis: 4 }])
    for (const entry of [...(meanSeries.markPoint?.data ?? []), ...(meanSeries.markLine?.data ?? [])]) {
      expect(typeof entry['xAxis']).toBe('number')
    }
  })
})
