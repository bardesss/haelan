// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because the wiring tests below need a real mount
// (createRoot + act) so useChart's own useEffect actually runs and calls echarts.init. The table
// tests further down still use renderToStaticMarkup, which runs no effects and so never touches
// echarts at all regardless of which environment the file runs under; moving to happy-dom does
// not change what they exercise.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { Sparkline, sparklinePointDate } from '../src/charts/Sparkline.js'
import { ActivityHeatmap, heatmapClickDate } from '../src/charts/ActivityHeatmap.js'
import { HeartRateRange, heartRateRangePointDate } from '../src/charts/HeartRateRange.js'
import { dayMarks, SYMBOL } from '../src/charts/base.js'
import type { DayMarks } from '../src/charts/base.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { DayRow } from '../src/fixtures/july.js'

// No I18nProvider anywhere in this file, on purpose: the same reason metric-card.test.tsx's own
// copy of this note gives. With no i18next instance initialised, t() returns the key it was asked
// for, so asserting on 'charts.absence.excluded' is asserting on the key the component chose, not
// on translated copy a locale file is free to reword.
const render = (node: React.ReactElement) => renderToStaticMarkup(node)

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason pages.test.tsx and chart-lifecycle.test.tsx set them. Needed even though
// echarts.init itself is mocked below: build(currentChartTokens()) still runs before the mocked
// setOption ever sees its argument.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance useChart.ts creates, so the wiring tests below can
 * mount a chart for real (running the actual useEffect, the actual `chart.on('click', ...)` call,
 * the actual ref, the actual onPointClick guard) without asking zrender to resolve a coordinate
 * against a rendered SVG, which an earlier experiment for this task established does not work
 * under happy-dom no matter how the click is simulated. Capturing the function handed to
 * `chart.on('click', ...)` and calling it directly exercises the same two lines a real click would
 * reach; only the browser's own hit-testing is out of scope, and it was never in scope, since
 * chart-marks.test.tsx already draws that line at the accessible table for the rest of this
 * file.
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

/** The function useChart.ts actually passed to `chart.on('click', ...)`, i.e. `handleClick`. */
function clickHandlerOf(stub: ChartStub): (event: unknown) => void {
  const call = stub.on.mock.calls.find(([event]) => event === 'click')
  if (!call) throw new Error('chart.on was never called with "click"')
  return call[1] as (event: unknown) => void
}

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

// useChart's own echarts.init call lives inside a useEffect, and renderToStaticMarkup runs no
// effects (render-environment.test.tsx's own point), so a Sparkline or ActivityHeatmap renders
// here without ever touching echarts, CHART_VARS, or a canvas. What's left standing is exactly
// the accessible table ChartFigure builds beside the chart host, which is the surface this file
// asserts against; the marks drawn on the chart itself are canvas-only and out of a test's reach,
// as the brief for this task states.
function table(html: string): string {
  const match = html.match(/<table class="sr-only">[\s\S]*?<\/table>/)
  if (!match) throw new Error(`no accessible table in:\n${html}`)
  return match[0]
}

/**
 * The last `<td>` in `date`'s own row: on all three charts the note column is the rightmost one
 * (Sparkline's [date, value, note], ActivityHeatmap's [date, weekday, steps, note],
 * HeartRateRange's [date, min, mean, max, note]), so this reads the same way for whichever chart's
 * markup it is handed. Used to compare a chart's own canvas label against the exact string its
 * table states for the same date, from one render, rather than each against its own hardcoded
 * expectation: two literals that happen to agree today prove nothing about tomorrow.
 */
function noteCellFor(html: string, date: string): string {
  const row = html.match(new RegExp(`<tr><th scope="row">${date}</th>[\\s\\S]*?</tr>`))
  if (!row) throw new Error(`no row for ${date}`)
  const cells = [...row[0].matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]!)
  const last = cells.at(-1)
  if (last === undefined) throw new Error(`no cells in row for ${date}`)
  return last
}

describe('Sparkline', () => {
  const values = [10, 20, 30]
  const labels = ['2026-08-01', '2026-08-02', '2026-08-03']
  // What an exclusion actually looks like once it has applied, and the fixture every excluded case
  // in this file used to get wrong: deriveDay deletes the excluded metric's daily row, /series then
  // omits that day, and the page's denseSeries turns the omission back into a position holding
  // null. Pairing an excluded date with a values array that still contains its number described
  // only the window before the derive caught up, which is precisely the window in which the
  // exclusion had NOT taken effect.
  const appliedValues = [10, null, 30]
  const EXCLUDED_REASON = 'phone left at home'

  it('renders an applied exclusion as a marked, explained gap rather than a missing day', () => {
    const html = render(
      <Sparkline values={appliedValues} labels={labels} label="steps" unit="steps"
        annotations={[{ date: '2026-08-02', text: EXCLUDED_REASON }]} excluded={['2026-08-02']} />,
    )
    const rows = table(html)
    // Three rows, not two: the day the reader excluded is still in the record, saying what it is.
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    const day2Row = rows.slice(rows.indexOf('2026-08-02'), rows.indexOf('2026-08-03'))
    expect(day2Row).toContain('charts.absence.noReading')
    expect(day2Row).toContain('charts.absence.excluded')
    expect(day2Row).toContain(EXCLUDED_REASON)
    // The two untouched days carry no such note.
    const day1Row = rows.slice(rows.indexOf('2026-08-01'), rows.indexOf('2026-08-02'))
    expect(day1Row).not.toContain('charts.absence.excluded')
  })

  it('marks an excluded date that still has its value, the window before the derive catches up', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[]} excluded={['2026-08-02']} />,
    )
    const rows = table(html)
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    const day2Row = rows.slice(rows.indexOf('2026-08-02'), rows.indexOf('2026-08-03'))
    expect(day2Row).toContain('charts.absence.excluded')
    expect(day2Row).not.toContain('charts.absence.noReading')
  })

  it('carries an annotation’s own text into its row', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[{ date: '2026-08-03', text: 'Flight to Chicago' }]} excluded={[]} />,
    )
    const rows = table(html)
    expect(rows).toContain('Flight to Chicago')
  })

  // Task 11b's own rule: an override reason, a note and an event can all land on one date once
  // day level marks join the per-metric ones, and the table must not silently keep only one of
  // them the way a find() (rather than a filter+join) would.
  it('joins every annotation on the same date rather than showing only the first', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[
          { date: '2026-08-02', text: 'Watch left charging' },
          { date: '2026-08-02', text: 'Flew to Tokyo' },
        ]} excluded={[]} />,
    )
    const rows = table(html)
    const day2Row = rows.slice(rows.indexOf('2026-08-02'), rows.indexOf('2026-08-03'))
    expect(day2Row).toContain('Watch left charging, Flew to Tokyo')
  })

  // A corrected day was not dropped: its replacement value is the number already on screen, so
  // calling it "excluded" would tell a reader the opposite of what happened. This pins the two
  // apart, in the one channel this environment can see (chartAnnotations.ts's own doc comment has
  // the full reasoning; the visual markPoint difference is canvas-only and hand-verified below).
  it('marks a corrected date differently from an excluded one, carrying its own value', () => {
    const html = render(
      <Sparkline values={values} labels={labels} label="steps" unit="steps"
        annotations={[]} excluded={['2026-08-01']} corrected={[{ date: '2026-08-02', value: 42 }]} />,
    )
    const rows = table(html)
    const excludedRow = rows.slice(rows.indexOf('2026-08-01'), rows.indexOf('2026-08-02'))
    const correctedRow = rows.slice(rows.indexOf('2026-08-02'), rows.indexOf('2026-08-03'))
    expect(excludedRow).toContain('charts.absence.excluded')
    expect(excludedRow).not.toContain('charts.absence.correctedTo')
    expect(correctedRow).toContain('charts.absence.correctedTo')
    expect(correctedRow).not.toContain('charts.absence.excluded')
  })

  it('leaves the table exactly as before when neither prop is passed', () => {
    // annotations/excluded default to empty rather than being required, so a page that has not
    // been migrated to pass them yet (every current caller) keeps compiling and keeps rendering
    // the same table it always has.
    const html = render(<Sparkline values={values} labels={labels} label="steps" unit="steps" />)
    const rows = table(html)
    expect(rows).not.toContain('charts.absence.excluded')
  })

  // The gap a day leaves once its exclusion applies is drawn as a markLine, since there is no
  // value under it for a markPoint to sit on. Read off the real setOption argument, because a
  // mark's presence and its placement are canvas-only and the accessible table cannot tell a
  // drawn mark from a dropped one.
  describe('the marks it draws for an applied exclusion', () => {
    function optionOf(): { series: { markPoint?: { data: unknown[] }, markLine?: { data: Record<string, unknown>[] } }[] } {
      const stub = chartStubs.at(-1)!
      return stub.setOption.mock.calls[0]![0] as never
    }

    it('draws the excluded day as a line at its own position, styled apart from an annotation', () => {
      act(() => {
        root!.render(
          <Sparkline values={appliedValues} labels={labels} label="steps" unit="steps"
            annotations={[{ date: '2026-08-02', text: EXCLUDED_REASON }]} excluded={['2026-08-02']} />,
        )
      })
      const series = optionOf().series[0]!
      // Nothing in the markPoint: there is no value left to anchor one at, which is the exact
      // reason the mark used to vanish altogether rather than move.
      expect(series.markPoint?.data).toEqual([])
      expect(series.markLine?.data).toEqual([{
        name: `charts.absence.excluded, ${EXCLUDED_REASON}`,
        xAxis: 1,
        // Solid and in the excluded colour, against the dashed annotation styling the markLine
        // carries by default: a gap the reader made has to read apart from a day that merely
        // carries a note, in line style as well as in colour, since colour alone is not a channel
        // every reader has.
        lineStyle: { color: '#000000', type: 'solid' },
      }])
    })

    it('says the same thing on the canvas as its own accessible table row states for that date', () => {
      act(() => {
        root!.render(
          <Sparkline values={appliedValues} labels={labels} label="steps" unit="steps"
            annotations={[{ date: '2026-08-02', text: EXCLUDED_REASON }]} excluded={['2026-08-02']} />,
        )
      })
      const markLineEntry = optionOf().series[0]!.markLine?.data[0]
      const noteCell = noteCellFor(container!.innerHTML, '2026-08-02')
      expect(noteCell).toBe(`charts.absence.excluded, ${EXCLUDED_REASON}`)
      expect(markLineEntry?.['name']).toBe(noteCell)
    })

    it('leaves an ordinary annotation dashed, so the two do not read the same', () => {
      act(() => {
        root!.render(
          <Sparkline values={values} labels={labels} label="steps" unit="steps"
            annotations={[{ date: '2026-08-02', text: 'Flew to Tokyo' }]} excluded={[]} />,
        )
      })
      expect(optionOf().series[0]!.markLine?.data).toEqual([{ name: 'Flew to Tokyo', xAxis: 1 }])
    })

    it('draws nothing for an excluded date this sparkline is not showing', () => {
      act(() => {
        root!.render(
          <Sparkline values={appliedValues} labels={labels} label="steps" unit="steps"
            annotations={[]} excluded={['2026-07-02']} />,
        )
      })
      const series = optionOf().series[0]!
      expect(series.markPoint?.data).toEqual([])
      expect(series.markLine?.data).toEqual([])
    })
  })

  describe('sparklinePointDate', () => {
    const noMarks: DayMarks = { atValue: [], atDate: [] }

    it('reads the local date off a genuine series click', () => {
      expect(sparklinePointDate(labels, noMarks, { componentType: 'series', dataIndex: 1 })).toBe('2026-08-02')
    })

    // The undo path for an applied exclusion, and the only one left: the day has no plotted point
    // for a click to land on, so the mark is the click target. This returned undefined for every
    // overlay click before, which is why the mark a reader clicked to undo did nothing.
    it('reads the local date off a click on the gap mark an applied exclusion leaves', () => {
      const marks = dayMarks({
        dates: labels, values: appliedValues, excluded: ['2026-08-02'], corrected: [],
        annotations: [{ date: '2026-08-02', text: EXCLUDED_REASON }], excludedText: 'excluded',
      })
      expect(sparklinePointDate(labels, marks, { componentType: 'markLine', dataIndex: 0 })).toBe('2026-08-02')
    })

    it('reads the local date off a click on the mark sitting over a day that still has its value', () => {
      const marks = dayMarks({
        dates: labels, values, excluded: ['2026-08-02'], corrected: [], annotations: [], excludedText: 'excluded',
      })
      expect(sparklinePointDate(labels, marks, { componentType: 'markPoint', dataIndex: 0 })).toBe('2026-08-02')
    })

    // An overlay's dataIndex counts into that overlay's own data array, which is much shorter than
    // `labels`: resolving it against `labels` would report the wrong date for most clicks on a
    // mark, and reporting a date for an index no mark occupies would report one for a click on
    // nothing at all.
    it('reports no date for an overlay index no mark occupies', () => {
      expect(sparklinePointDate(labels, noMarks, { componentType: 'markPoint', dataIndex: 0 })).toBeUndefined()
      expect(sparklinePointDate(labels, noMarks, { componentType: 'markLine', dataIndex: 0 })).toBeUndefined()
    })
  })
})

describe('ActivityHeatmap', () => {
  const days: DayRow[] = [
    { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    { date: '2026-07-07', steps: 9000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    { date: '2026-07-08', steps: 5000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
  ]

  it('marks an excluded date rather than dropping its row', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[]} excluded={['2026-07-07']} />,
    )
    const rows = table(html)
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    expect(rows).toContain('2026-07-07')
    expect(rows).toContain('charts.absence.excluded')
  })

  it('carries an annotation’s own text into its row', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[{ date: '2026-07-08', text: 'Three glasses of wine' }]} excluded={[]} />,
    )
    const rows = table(html)
    expect(rows).toContain('Three glasses of wine')
  })

  // Same rule Sparkline's own copy of this test pins: several annotations on one date must all
  // reach the table, joined, not just the first found.
  it('joins every annotation on the same date rather than showing only the first', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[
          { date: '2026-07-07', text: 'Watch left charging' },
          { date: '2026-07-07', text: 'Flew to Tokyo' },
        ]} excluded={[]} />,
    )
    const rows = table(html)
    const day7Row = rows.slice(rows.indexOf('2026-07-07'), rows.indexOf('2026-07-08'))
    expect(day7Row).toContain('Watch left charging, Flew to Tokyo')
  })

  // Same distinction Sparkline's own copy of this test pins, and the same reason: a corrected day
  // was not dropped, so telling a reader "excluded" over it says the opposite of what happened.
  it('marks a corrected date differently from an excluded one', () => {
    const html = render(
      <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
        annotations={[]} excluded={['2026-07-06']} corrected={[{ date: '2026-07-07', value: 42 }]} />,
    )
    const rows = table(html)
    const excludedRow = rows.slice(rows.indexOf('2026-07-06'), rows.indexOf('2026-07-07'))
    const correctedRow = rows.slice(rows.indexOf('2026-07-07'), rows.indexOf('2026-07-08'))
    expect(excludedRow).toContain('charts.absence.excluded')
    expect(excludedRow).not.toContain('charts.absence.correctedTo')
    expect(correctedRow).toContain('charts.absence.correctedTo')
    expect(correctedRow).not.toContain('charts.absence.excluded')
  })

  it('leaves the table exactly as before when neither prop is passed', () => {
    // Same default-empty-array device Sparkline's own copy of this test guards, and the same
    // reason: every current caller (Activity.tsx) does not pass annotations/excluded yet.
    const html = render(<ActivityHeatmap days={days} max={9000} label="calendar heatmap" />)
    const rows = table(html)
    expect(rows).not.toContain('charts.absence.excluded')
  })

  // The heatmap is the one chart of the three that never lost its excluded mark, because a cell
  // is a coordinate on two category axes rather than a height: a day with no steps still has a
  // cell to mark. This pins that, against the applied shape (steps null) rather than against a
  // fixture that still carries the excluded day's number.
  it('keeps the mark and the row for an excluded day whose steps are gone', () => {
    const applied: DayRow[] = [
      { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-07', steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-08', steps: 5000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <ActivityHeatmap days={applied} max={9000} label="calendar heatmap" corrected={[]}
          excluded={['2026-07-07']} annotations={[{ date: '2026-07-07', text: 'phone left at home' }]} />,
      )
    })
    const stub = chartStubs.at(-1)!
    const option = stub.setOption.mock.calls[0]![0] as { series: { markPoint?: { data: Record<string, unknown>[] } }[] }
    const excludedMark = option.series[0]!.markPoint?.data.find((d) => d.name === 'excluded')
    expect(excludedMark).toMatchObject({ coord: [0, 1] })
    const rows = table(container!.innerHTML)
    const day7Row = rows.slice(rows.indexOf('2026-07-07'), rows.indexOf('2026-07-08'))
    expect(day7Row).toContain('charts.absence.noReading')
    expect(day7Row).toContain('charts.absence.excluded')
    expect(day7Row).toContain('phone left at home')
  })

  describe('heatmapClickDate', () => {
    const cells = [
      { date: '2026-07-06', week: 0, weekday: 0 },
      { date: '2026-07-07', week: 0, weekday: 1 },
      { date: '2026-07-08', week: 0, weekday: 2 },
    ]
    const noMarks: string[] = []

    it('reads the local date off the [week, weekday, steps] tuple a genuine series click reports', () => {
      expect(heatmapClickDate(cells, noMarks, { componentType: 'series', value: [0, 1, 9000] })).toBe('2026-07-07')
    })

    it('reads the local date off the shorter [week, weekday] tuple the absence scatter series reports', () => {
      expect(heatmapClickDate(cells, noMarks, { componentType: 'series', value: [0, 2] })).toBe('2026-07-08')
    })

    // An excluded day's mark sits directly on the absence dot for the same cell, so a click aimed
    // at the mark a reader wants to undo lands on the mark rather than falling through. Resolving
    // it against `markDates` is what keeps that click working; a markPoint's own value is a marker
    // descriptor (name/coord/itemStyle) and names no cell, so there is nothing else to read it off.
    it('reads the local date off a click on a markPoint, by that overlay\'s own index', () => {
      expect(heatmapClickDate(cells, ['2026-07-07'], { componentType: 'markPoint', dataIndex: 0, value: undefined }))
        .toBe('2026-07-07')
    })

    it('reports no date for a markPoint index no mark occupies', () => {
      expect(heatmapClickDate(cells, noMarks, { componentType: 'markPoint', dataIndex: 0, value: undefined }))
        .toBeUndefined()
    })
  })

  // Round 2's own finding: an override reason, a note and an event can all land on one date now,
  // and one markPoint entry per annotation put every one of them at the same coord, each with its
  // own label at markPoint's default inside-the-marker position, overlapping rather than reading
  // apart. Reads the real `setOption` argument (the table alone cannot tell one overlapping mark
  // from several, only the accessible table's own text, which was never in question here).
  it('draws one annotation markPoint per date, not one per annotation, with their text joined', () => {
    act(() => {
      root!.render(
        <ActivityHeatmap days={days} max={9000} label="calendar heatmap" excluded={[]} corrected={[]}
          annotations={[
            { date: '2026-07-07', text: 'Watch left charging' },
            { date: '2026-07-07', text: 'Flew to Tokyo' },
          ]} />,
      )
    })
    const stub = chartStubs.at(-1)!
    const option = stub.setOption.mock.calls[0]![0] as { series: { markPoint?: { data: Record<string, unknown>[] } }[] }
    const heatmapSeries = option.series[0]!
    const diamonds = heatmapSeries.markPoint?.data.filter((d) => d.symbol === 'diamond') ?? []
    expect(diamonds).toEqual([{ name: 'Watch left charging, Flew to Tokyo', coord: [0, 1], symbol: 'diamond', itemStyle: { color: '#000000' } }])
  })

  // Round 3's own finding: the join above and the table's own join (Sparkline/ActivityHeatmap/
  // HeartRateRange all filter+join with ANNOTATION_JOIN) were two separate literals that happened
  // to agree, with nothing comparing them. This reads both off the one render above instead of
  // each against its own hardcoded string, so a future change to one that the other misses fails
  // here rather than staying invisible.
  it('draws the same joined text on the canvas as its own accessible table states for that date', () => {
    act(() => {
      root!.render(
        <ActivityHeatmap days={days} max={9000} label="calendar heatmap" excluded={[]} corrected={[]}
          annotations={[
            { date: '2026-07-07', text: 'Watch left charging' },
            { date: '2026-07-07', text: 'Flew to Tokyo' },
          ]} />,
      )
    })
    const stub = chartStubs.at(-1)!
    const option = stub.setOption.mock.calls[0]![0] as { series: { markPoint?: { data: Record<string, unknown>[] } }[] }
    const diamond = option.series[0]!.markPoint?.data.find((d) => d.symbol === 'diamond')
    const noteCell = noteCellFor(container!.innerHTML, '2026-07-07')
    // Sanity against a vacuous pass (both sides empty or undefined would also satisfy toBe below).
    expect(noteCell).toBe('Watch left charging, Flew to Tokyo')
    expect(diamond?.name).toBe(noteCell)
  })

  // Round 3's other finding: excluded, corrected and annotation all share this series' one
  // markPoint, and a day_metric override is reachable alongside a note or an event since this
  // task (excluded/corrected cannot collide with each other or with an annotation the way two
  // annotations could, but an override mark and an annotation mark on the same date now can).
  // Two entries at the identical coord each carrying their own label, echarts' own default markPoint
  // label position, drew as two overlapping strings on one pixel: the same overprint the round 2
  // fix closed within the annotation group, reachable again across mark groups.
  it('suppresses the markPoint label for the whole series, so an excluded date and an annotated one never stack two labels on one coord', () => {
    act(() => {
      root!.render(
        <ActivityHeatmap days={days} max={9000} label="calendar heatmap"
          excluded={['2026-07-07']} corrected={[]}
          annotations={[{ date: '2026-07-07', text: 'Watch left charging' }]} />,
      )
    })
    const stub = chartStubs.at(-1)!
    const option = stub.setOption.mock.calls[0]![0] as {
      series: { markPoint?: { label?: { show: boolean }, data: Record<string, unknown>[] } }[]
    }
    const markPoint = option.series[0]!.markPoint!
    // At most one label drawn per coordinate: the whole series draws none, which is trivially at
    // most one everywhere, not merely at the one coordinate this fixture exercises.
    expect(markPoint.label).toEqual({ show: false })
    // Shape and colour still tell the two groups apart with the label off, which is what Task 11's
    // own Important 4 requires (a reader, colour-blind or not, has to tell a correction/exclusion
    // apart from an annotation in every channel this chart draws).
    const excludedMark = markPoint.data.find((d) => d.name === 'excluded')
    const annotationMark = markPoint.data.find((d) => d.name === 'Watch left charging')
    expect(excludedMark).toMatchObject({ coord: [0, 1], itemStyle: { color: '#000000' } })
    expect(annotationMark).toMatchObject({ coord: [0, 1], symbol: 'diamond' })
    expect(excludedMark?.symbol).not.toBe(annotationMark?.symbol)
  })
})

describe('HeartRateRange', () => {
  // All three of annotations/excluded/corrected required, unlike Sparkline and ActivityHeatmap:
  // HeartRateRange has taken this trio since D1 (annotations/excluded) and this task (corrected),
  // never optional, so every render below passes all three regardless of whether it exercises one.
  const days: DayRow[] = [
    { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
    { date: '2026-08-11', steps: null, hrMin: 54, hrMean: 61, hrMax: 70, sleepMinutes: null, worn: true },
    { date: '2026-08-12', steps: null, hrMin: 56, hrMean: 59, hrMax: 66, sleepMinutes: null, worn: true },
  ]

  it('marks an excluded date rather than dropping its row', () => {
    const html = render(
      <HeartRateRange days={days} annotations={[]} excluded={['2026-08-11']} corrected={[]} label="hr range" />,
    )
    const rows = table(html)
    expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
    expect(rows).toContain('2026-08-11')
    expect(rows).toContain('charts.absence.excluded')
  })

  it('carries an annotation’s own text into its row', () => {
    const html = render(
      <HeartRateRange days={days} annotations={[{ date: '2026-08-12', text: 'Flight to Chicago' }]}
        excluded={[]} corrected={[]} label="hr range" />,
    )
    const rows = table(html)
    expect(rows).toContain('Flight to Chicago')
  })

  // Same rule Sparkline's and ActivityHeatmap's own copies of this test pin: several annotations
  // on one date must all reach the table, joined, not just the first found.
  it('joins every annotation on the same date rather than showing only the first', () => {
    const html = render(
      <HeartRateRange days={days} excluded={[]} corrected={[]}
        annotations={[
          { date: '2026-08-11', text: 'Watch left charging' },
          { date: '2026-08-11', text: 'Flew to Tokyo' },
        ]} label="hr range" />,
    )
    const rows = table(html)
    const day11Row = rows.slice(rows.indexOf('2026-08-11'), rows.indexOf('2026-08-12'))
    expect(day11Row).toContain('Watch left charging, Flew to Tokyo')
  })

  // Same distinction Sparkline's and ActivityHeatmap's own copies of this test pin: a corrected
  // day was not dropped, so telling a reader "excluded" over it says the opposite of what
  // happened. HeartRateRange is the one chart carrying `!d.worn` in the same note cell, so this
  // also pins that a corrected mark does not fight the wear clause for the same cell.
  it('marks a corrected date differently from an excluded one', () => {
    const html = render(
      <HeartRateRange days={days} annotations={[]} excluded={['2026-08-10']}
        corrected={[{ date: '2026-08-11', value: 58 }]} label="hr range" />,
    )
    const rows = table(html)
    const excludedRow = rows.slice(rows.indexOf('2026-08-10'), rows.indexOf('2026-08-11'))
    const correctedRow = rows.slice(rows.indexOf('2026-08-11'), rows.indexOf('2026-08-12'))
    expect(excludedRow).toContain('charts.absence.excluded')
    expect(excludedRow).not.toContain('charts.absence.correctedTo')
    expect(correctedRow).toContain('charts.absence.correctedTo')
    expect(correctedRow).not.toContain('charts.absence.excluded')
  })

  // What an applied exclusion leaves behind on this chart: the whole metric's day is gone, so all
  // three of min, mean and max are null and there is no height left for a markPoint to sit at.
  // Every excluded case above pairs an excluded date with a day that still carries its numbers,
  // which is only the window before the derive catches up.
  const appliedDays: DayRow[] = [
    { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
    // worn stays true with nothing to report, the same way Dashboard.tsx builds it: a missing point
    // says nothing about whether the device was on the wrist, so the note cell carries no wear
    // clause and states only what the reader did to this day.
    { date: '2026-08-11', steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    { date: '2026-08-12', steps: null, hrMin: 56, hrMean: 59, hrMax: 66, sleepMinutes: null, worn: true },
  ]
  const EXCLUDED_REASON = 'strap was off all day'

  describe('an exclusion that has applied', () => {
    function meanSeriesOf(): { markPoint?: { data: unknown[] }, markLine?: { data: Record<string, unknown>[] } } {
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: Record<string, never>[] }
      return option.series[2]! as never
    }

    function renderApplied(): void {
      act(() => {
        root!.render(
          <HeartRateRange days={appliedDays} corrected={[]} excluded={['2026-08-11']}
            annotations={[{ date: '2026-08-11', text: EXCLUDED_REASON }]} label="hr range" />,
        )
      })
    }

    it('draws the day as a line at its own position rather than dropping the mark', () => {
      renderApplied()
      const meanSeries = meanSeriesOf()
      // Empty because there is no mean to anchor a markPoint at, which is exactly why the mark
      // used to disappear the moment the exclusion took effect instead of moving here.
      expect(meanSeries.markPoint?.data).toEqual([])
      expect(meanSeries.markLine?.data).toEqual([{
        name: `charts.absence.excluded, ${EXCLUDED_REASON}`,
        xAxis: 1,
        lineStyle: { color: '#000000', type: 'solid' },
      }])
    })

    it('labels the line with the same text its own accessible table row states for that date', () => {
      renderApplied()
      const markLineEntry = meanSeriesOf().markLine?.data[0]
      const noteCell = noteCellFor(container!.innerHTML, '2026-08-11')
      expect(noteCell).toBe(`charts.absence.excluded, ${EXCLUDED_REASON}`)
      expect(markLineEntry?.['name']).toBe(noteCell)
    })

    it('keeps the row in the accessible table, reading no reading and excluded rather than going quiet', () => {
      renderApplied()
      const rows = table(container!.innerHTML)
      expect([...rows.matchAll(/<th scope="row">/g)]).toHaveLength(3)
      const day11Row = rows.slice(rows.indexOf('2026-08-11'), rows.indexOf('2026-08-12'))
      expect(day11Row).toContain('charts.absence.noReading')
      expect(day11Row).toContain('charts.absence.excluded')
      expect(day11Row).toContain(EXCLUDED_REASON)
      expect(day11Row).not.toContain('charts.absence.notWorn')
    })
  })

  describe('heartRateRangePointDate', () => {
    const noMarks: DayMarks = { atValue: [], atDate: [] }

    it('reads the local date off a genuine series click, regardless of which of the three stacked series it landed on', () => {
      // dataIndex is a position on the shared category axis, not tied to one series: min, range
      // and mean all report the same dataIndex for the same day.
      expect(heartRateRangePointDate(days, noMarks, { componentType: 'series', dataIndex: 1 })).toBe('2026-08-11')
    })

    // The undo path for an applied exclusion: none of the three series is drawn on that day, so
    // the mark is the only thing a click can land on. Every overlay click used to resolve to
    // nothing, which left the reader with no way back to the panel for the day they excluded.
    it('reads the local date off a click on the gap mark an applied exclusion leaves', () => {
      const marks = dayMarks({
        dates: appliedDays.map((d) => d.date), values: appliedDays.map((d) => d.hrMean),
        excluded: ['2026-08-11'], corrected: [],
        annotations: [{ date: '2026-08-11', text: EXCLUDED_REASON }], excludedText: 'excluded',
      })
      expect(heartRateRangePointDate(appliedDays, marks, { componentType: 'markLine', dataIndex: 0 })).toBe('2026-08-11')
    })

    it('reports no date for an overlay index no mark occupies', () => {
      expect(heartRateRangePointDate(days, noMarks, { componentType: 'markPoint', dataIndex: 0 })).toBeUndefined()
      expect(heartRateRangePointDate(days, noMarks, { componentType: 'markLine', dataIndex: 0 })).toBeUndefined()
    })
  })

  // The Critical this task's review round found, in two layers. First: the markLine data below
  // used to be `annotations.map(...)` with no membership filter, unlike the markPoint four lines
  // above it in HeartRateRange.tsx and unlike both Sparkline's and ActivityHeatmap's own
  // markPoint/markLine filters, so an override from outside the visible range reached this chart
  // at all. Second, and the one the filter alone did not close: this chart's x axis is
  // `days.map(d => d.date.slice(8))`, a day-of-month label, and a category axis's markPoint/
  // markLine `xAxis` resolves a string against that axis's own `data` by name, matching the FIRST
  // entry that carries it. `.slice(8)` was still the positioning key after the filter landed, so
  // two visible days sharing a day-of-month (`3months`/`year` draw one point per calendar day
  // across several months, with no downsampling) collided on each other even though both passed
  // the filter and neither was out of range. Both cases are pinned below: the first against a day
  // genuinely outside `days`, the second against two in-range days that share a label. Reads
  // `setOption`'s own captured argument, since a mark's placement is drawn on the canvas and the
  // accessible table alone cannot tell either defect apart from its fix.
  describe('the annotation markLine only ever names a day this chart is actually drawing', () => {
    it('drops an annotation for a date outside the visible range rather than placing it on a day sharing its day-of-month', () => {
      act(() => {
        root!.render(
          <HeartRateRange days={days} excluded={[]} corrected={[]}
            annotations={[{ date: '2026-07-11', text: 'Watch left charging' }]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: { markLine?: { data: unknown[] } }[] }
      const meanSeries = option.series[2]!
      expect(meanSeries.markLine?.data).toEqual([])
    })

    it('draws an annotation for a date actually inside the visible range, positioned by index', () => {
      act(() => {
        root!.render(
          <HeartRateRange days={days} excluded={[]} corrected={[]}
            annotations={[{ date: '2026-08-11', text: 'Watch left charging' }]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: { markLine?: { data: unknown[] } }[] }
      const meanSeries = option.series[2]!
      // xAxis is 1, `days`' own array position for 2026-08-11, not the string "11": a numeric
      // category index cannot collide with another day the way a repeating day-of-month label can.
      expect(meanSeries.markLine?.data).toEqual([{ name: 'Watch left charging', xAxis: 1 }])
    })

    // Round 2's own finding: an override reason, a note and an event can all land on one date now,
    // and one markLine entry per annotation put every one of them at the same xAxis, each labelled
    // at echarts' default `position: 'end'` for a markLine label, overlapping rather than reading
    // apart.
    it('draws one annotation markLine per date, not one per annotation, with their text joined', () => {
      act(() => {
        root!.render(
          <HeartRateRange days={days} excluded={[]} corrected={[]}
            annotations={[
              { date: '2026-08-11', text: 'Watch left charging' },
              { date: '2026-08-11', text: 'Flew to Tokyo' },
            ]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: { markLine?: { data: unknown[] } }[] }
      const meanSeries = option.series[2]!
      expect(meanSeries.markLine?.data).toEqual([{ name: 'Watch left charging, Flew to Tokyo', xAxis: 1 }])
    })

    // Round 3's own finding: the join above and the table's own join were two separate literals
    // that happened to agree, with nothing comparing them. Same device ActivityHeatmap's own copy
    // of this test uses: read both off the one render, not each against its own hardcoded string.
    it('draws the same joined text on the canvas as its own accessible table states for that date', () => {
      act(() => {
        root!.render(
          <HeartRateRange days={days} excluded={[]} corrected={[]}
            annotations={[
              { date: '2026-08-11', text: 'Watch left charging' },
              { date: '2026-08-11', text: 'Flew to Tokyo' },
            ]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as { series: { markLine?: { data: { name: string, xAxis: number }[] } }[] }
      const meanSeries = option.series[2]!
      const markLineEntry = meanSeries.markLine?.data[0]
      const noteCell = noteCellFor(container!.innerHTML, '2026-08-11')
      expect(noteCell).toBe('Watch left charging, Flew to Tokyo')
      expect(markLineEntry?.name).toBe(noteCell)
    })

    // The reviewer's own measurement: a six day range spanning two months, both sharing the same
    // three day-of-month labels ("10","11","12"), with an exclude and an annotation override on
    // the second month's "11" and a correct override on the second month's "10". A string
    // positioned mark resolves e.g. `"11"` against the axis's data and lands on the FIRST match,
    // 2026-07-11 (index 1), at 2026-07-11's own height; an index positioned mark lands on the day
    // actually named, 2026-08-11 (index 4), at its own mean. All three mark groups (excluded,
    // corrected, annotations) are checked in one range, since all three share the exact defect and
    // the exact fix: the round this test was first written in covered only excluded and
    // annotations, which left the third of the fix (the corrected markPoint entry, still keyed on
    // `date.slice(8)` at review time) provably able to regress with the whole suite staying green.
    it('resolves a mark to the day it actually names, not the first day sharing its day-of-month, across a two month range', () => {
      const twoMonthDays: DayRow[] = [
        { date: '2026-07-10', steps: null, hrMin: 50, hrMean: 55, hrMax: 60, sleepMinutes: null, worn: true },
        { date: '2026-07-11', steps: null, hrMin: 51, hrMean: 56, hrMax: 61, sleepMinutes: null, worn: true },
        { date: '2026-07-12', steps: null, hrMin: 52, hrMean: 57, hrMax: 62, sleepMinutes: null, worn: true },
        { date: '2026-08-10', steps: null, hrMin: 53, hrMean: 58, hrMax: 63, sleepMinutes: null, worn: true },
        { date: '2026-08-11', steps: null, hrMin: 54, hrMean: 64, hrMax: 70, sleepMinutes: null, worn: true },
        { date: '2026-08-12', steps: null, hrMin: 55, hrMean: 60, hrMax: 65, sleepMinutes: null, worn: true },
      ]
      act(() => {
        root!.render(
          <HeartRateRange days={twoMonthDays} excluded={['2026-08-11']}
            corrected={[{ date: '2026-08-10', value: 58 }]}
            annotations={[{ date: '2026-08-11', text: 'Watch left charging' }]} label="hr range" />,
        )
      })
      const stub = chartStubs.at(-1)!
      const option = stub.setOption.mock.calls[0]![0] as {
        series: { markPoint?: { data: unknown[] }, markLine?: { data: unknown[] } }[]
      }
      const meanSeries = option.series[2]!
      // excluded at index 4 (2026-08-11, mean 64), never index 1 (2026-07-11, mean 56).
      // corrected at index 3 (2026-08-10, mean 58), never index 0 (2026-07-10, mean 55).
      expect(meanSeries.markPoint?.data).toEqual([
        { name: 'excluded', xAxis: 4, yAxis: 64 },
        { name: 'corrected', symbol: 'rect', symbolSize: SYMBOL.corrected, itemStyle: { color: '#000000' }, xAxis: 3, yAxis: 58 },
      ])
      expect(meanSeries.markLine?.data).toEqual([{ name: 'Watch left charging', xAxis: 4 }])
    })
  })
})

// The pure functions above prove the date arithmetic; they say nothing about whether a real click
// ever reaches `onPointClick`, since neither Sparkline nor ActivityHeatmap calls them directly.
// The actual path is chart.on('click', handleClick) -> the onClickRef useChart.ts keeps -> the `if
// (date !== undefined)` guard each chart's own onClick wraps sparklinePointDate/heatmapClickDate
// in. Dropping the third argument to useChart, or inverting that guard, would leave every test
// above green. These tests mount for real (so the actual useEffect runs and actually calls
// chart.on) and invoke the captured handler directly (so no coordinate ever needs resolving).
describe('the click each chart hands to onPointClick', () => {
  it('Sparkline reports the label at the series point a genuine click landed on', () => {
    const onPointClick = vi.fn()
    act(() => {
      root!.render(
        <Sparkline values={[10, 20, 30]} labels={['2026-08-01', '2026-08-02', '2026-08-03']}
          label="steps" unit="steps" onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', dataIndex: 1 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-02')
  })

  it('Sparkline does not call back for a click that misses the series', () => {
    const onPointClick = vi.fn()
    act(() => {
      root!.render(
        <Sparkline values={[10, 20, 30]} labels={['2026-08-01', '2026-08-02', '2026-08-03']}
          label="steps" unit="steps" onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    // No marks at all on this render, so this index names nothing rather than naming a mark.
    handleClick({ componentType: 'markPoint', dataIndex: 0 })
    expect(onPointClick).not.toHaveBeenCalled()
  })

  // The undo path, end to end through the wiring rather than through the pure function alone: an
  // applied exclusion leaves no plotted point on that day, so unless the mark itself reaches
  // onPointClick the reader cannot reopen the panel on the day they excluded at all.
  it('Sparkline reports the excluded day when the gap mark it left is clicked', () => {
    const onPointClick = vi.fn()
    act(() => {
      root!.render(
        <Sparkline values={[10, null, 30]} labels={['2026-08-01', '2026-08-02', '2026-08-03']}
          label="steps" unit="steps" excluded={['2026-08-02']}
          annotations={[{ date: '2026-08-02', text: 'phone left at home' }]} onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markLine', dataIndex: 0 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-02')
  })

  it('ActivityHeatmap reports the date the clicked cell’s [week, weekday, steps] tuple names', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-07', steps: 9000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-08', steps: 5000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(<ActivityHeatmap days={days} max={9000} label="calendar heatmap" onPointClick={onPointClick} />)
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', value: [0, 1, 9000] })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-07-07')
  })

  it('ActivityHeatmap does not call back for a click on a markPoint overlay it drew nothing in', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(<ActivityHeatmap days={days} max={9000} label="calendar heatmap" onPointClick={onPointClick} />)
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', dataIndex: 0, value: undefined })
    expect(onPointClick).not.toHaveBeenCalled()
  })

  // An excluded cell's mark sits on top of the absence dot for the same day, so this click is the
  // one a reader aiming at the mark actually makes.
  it('ActivityHeatmap reports the excluded day when its own mark is clicked', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-07-06', steps: 4000, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
      { date: '2026-07-07', steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <ActivityHeatmap days={days} max={9000} label="calendar heatmap" excluded={['2026-07-07']}
          onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', dataIndex: 0, value: undefined })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-07-07')
  })

  // HeartRateRange gained onPointClick in this same review round, following the ref based pattern
  // the two charts above already use: the handler lives outside `build`'s own dependency array
  // (useChart.ts keeps it in a ref), so a fresh closure every render never disposes the chart.
  it('HeartRateRange reports the date at the dataIndex a genuine click landed on', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
      { date: '2026-08-11', steps: null, hrMin: 54, hrMean: 61, hrMax: 70, sleepMinutes: null, worn: true },
      { date: '2026-08-12', steps: null, hrMin: 56, hrMean: 59, hrMax: 66, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <HeartRateRange days={days} annotations={[]} excluded={[]} corrected={[]} label="hr range"
          onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'series', dataIndex: 1 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-11')
  })

  it('HeartRateRange does not call back for a click on an overlay it drew nothing in', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <HeartRateRange days={days} annotations={[]} excluded={[]} corrected={[]} label="hr range"
          onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markPoint', dataIndex: 0 })
    expect(onPointClick).not.toHaveBeenCalled()
  })

  it('HeartRateRange reports the excluded day when the gap mark it left is clicked', () => {
    const onPointClick = vi.fn()
    const days: DayRow[] = [
      { date: '2026-08-10', steps: null, hrMin: 55, hrMean: 60, hrMax: 68, sleepMinutes: null, worn: true },
      { date: '2026-08-11', steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: true },
    ]
    act(() => {
      root!.render(
        <HeartRateRange days={days} corrected={[]} excluded={['2026-08-11']}
          annotations={[{ date: '2026-08-11', text: 'strap was off all day' }]} label="hr range"
          onPointClick={onPointClick} />,
      )
    })
    const handleClick = clickHandlerOf(chartStubs.at(-1)!)
    handleClick({ componentType: 'markLine', dataIndex: 0 })
    expect(onPointClick).toHaveBeenCalledTimes(1)
    expect(onPointClick).toHaveBeenCalledWith('2026-08-11')
  })
})
