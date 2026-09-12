// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: the colour tests below need a real mount
// (createRoot + act) so useChart's own useEffect actually runs and calls echarts.init, the same
// reason chart-marks.test.tsx and intraday-chart.test.tsx give for their own files.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { EChartsOption } from 'echarts'
import { ZoneBar, SESSION_ZONE_KEYS } from '../src/charts/ZoneBar.js'
import type { ZoneRow } from '../src/charts/ZoneBar.js'
import { CHART_VARS } from '../src/charts/tokens.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason chart-marks.test.tsx and chart-lifecycle.test.tsx set them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

// Five DISTINCT stops, not the uniform '#000000' the loop above leaves every other token at: a
// test asserting which stop a zone drew in would pass trivially against a ramp where every stop is
// the same colour, which is exactly why this file cannot stop at the loop above the way every
// other chart test in this app does.
const STOPS = ['#000001', '#000002', '#000003', '#000004', '#000005']
const SCALE_VARS = ['--chart-scale-1', '--chart-scale-2', '--chart-scale-3', '--chart-scale-4', '--chart-scale-5']
SCALE_VARS.forEach((variable, i) => document.documentElement.style.setProperty(variable, STOPS[i]!))

/**
 * Stands in for the real echarts instance useChart.ts creates, the same stub chart-marks.test.tsx
 * and intraday-chart.test.tsx use, so `setOption`'s own argument (the option ZoneBar actually
 * built) can be captured without a real canvas.
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

const row = (zone: (typeof SESSION_ZONE_KEYS)[number], minutes: number): ZoneRow =>
  ({ zone, label: zone, minutes })

/** The `itemStyle.color` each series in the real setOption call carries, in series order. */
function colorsFor(rows: ZoneRow[]): string[] {
  act(() => { root!.render(<ZoneBar rows={rows} label="Time in heart rate zones" />) })
  const option = chartStubs.at(-1)!.setOption.mock.calls[0]![0] as EChartsOption
  return (option.series as { itemStyle: { color: string } }[]).map((s) => s.itemStyle.color)
}

describe('ZoneBar', () => {
  // Final review finding: colour used to be picked by a row's own position in `rows`, which only
  // ever carries the zones a session recorded (zoneRows in WorkoutZones.tsx drops any zone the
  // session did not). A session that skips a zone in the middle of the ramp used to slide every
  // zone after it into the wrong stop.
  it('colours a light+peak session\'s peak zone by its own fixed position, not by its row\'s position among the two zones recorded', () => {
    const colors = colorsFor([row('light', 10), row('peak', 2)])
    // light is SESSION_ZONE_KEYS[0], peak is SESSION_ZONE_KEYS[3].
    expect(colors).toEqual([STOPS[0], STOPS[3]])
    // The defect this guards: peak drawn in the second stop because it was the second row.
    expect(colors[1]).not.toBe(STOPS[1])
  })

  it('colours a peak-only session\'s one row with peak\'s own stop, not the lightest one', () => {
    const colors = colorsFor([row('peak', 5)])
    expect(colors).toEqual([STOPS[3]])
    // The defect this guards: the hardest zone drawn in the lightest stop because it was the only
    // (and therefore first) row.
    expect(colors[0]).not.toBe(STOPS[0])
  })

  it('still draws every zone in its own stop, in order, when a session recorded all four', () => {
    const colors = colorsFor([row('light', 1), row('moderate', 2), row('vigorous', 3), row('peak', 4)])
    expect(colors).toEqual([STOPS[0], STOPS[1], STOPS[2], STOPS[3]])
  })

  // Final review finding: the accessible table's second column was headed "Minutes" while its own
  // cells printed formatDuration's "Xh XXm", never a bare minute count. No I18nProvider (as
  // elsewhere in this app's chart tests), so t() returns the raw key, and the two header/cell
  // assertions below are read from the same render rather than compared against a hardcoded string
  // each, so a header changed without its cell (or the reverse) fails here.
  it('heads its accessible table with the same unit its own cells print', () => {
    const html = renderToStaticMarkup(
      <ZoneBar rows={[row('light', 70)]} label="Time in heart rate zones" />,
    )
    const headers = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]!)
    expect(headers).toEqual(['activity.workout.zones.column', 'activity.workout.zones.duration'])
    expect(headers).not.toContain('activity.units.minutes')
    // 70 minutes prints as "1h 10m", never a bare "70". The zone name is the row's own header
    // cell (ChartFigure.tsx renders column 0 as `<th scope="row">`), duration the one `<td>`.
    expect(html).toContain('<th scope="row">light</th>')
    const cells = [...html.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]!)
    expect(cells).toEqual(['1h 10m'])
  })
})
