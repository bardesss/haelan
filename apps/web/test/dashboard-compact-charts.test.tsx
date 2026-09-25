// @vitest-environment happy-dom
//
// happy-dom, and echarts/core's init stubbed, for the reason intraday-chart.test.tsx gives: these
// cases read the option a mounted chart hands setOption, which only exists once useChart's effect
// has run. The dashboard's compact forms (spec amendment 2026-09-24, the approved T2 mockup) live
// behind new props that default off, so every case here passes one; the charts' default forms are
// pinned by their own files, unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { Sparkline } from '../src/charts/Sparkline.js'
import type { PointStanding } from '../src/charts/Sparkline.js'
import { Hypnogram } from '../src/charts/Hypnogram.js'
import { IntradayHeartRate } from '../src/charts/IntradayHeartRate.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import type { IntradayPoint } from '../src/data/useIntraday.js'
import { localMidnightMs } from '../src/pages/dashboard/glanceText.js'

// Every token its own value, so a colour in the option names the token it came from.
const SERIES = '#000001'
const PRIMARY = '#000002'
const NEGATIVE = '#000003'
const SURFACE = '#000004'
const OWN: Record<string, string> = {
  '--chart-series': SERIES, '--text-primary': PRIMARY, '--negative': NEGATIVE, '--surface-card': SURFACE,
}
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, OWN[variable] ?? '#000000')

let lastOption: Record<string, unknown> | undefined
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    init: () => ({ on: vi.fn(), setOption: (option: Record<string, unknown>) => { lastOption = option }, dispose: vi.fn(), resize: vi.fn() }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  lastOption = undefined
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

const SESSION: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), SESSION)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  act(() => {
    root!.render(<I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>)
  })
  return container!
}

type LineSeries = { data: unknown[], showSymbol?: boolean, markArea?: { data: unknown[] } }
function seriesOf(option: Record<string, unknown> | undefined): LineSeries[] {
  return (option?.series ?? []) as LineSeries[]
}

// The accessible path the dashboard keeps with the visible control gone: the table is in the
// document, clipped the way ChartFigure clips it before its control is pressed, and nothing else.
function expectTableForAssistiveTechOnly(host: HTMLElement, rows: number) {
  expect(host.querySelector('.chart-table-toggle')).toBeNull()
  expect(host.querySelector('button')).toBeNull()
  const table = host.querySelector('table')
  expect(table?.className).toBe('sr-only')
  expect(table?.parentElement?.className).toBe('sr-only')
  expect(table?.querySelectorAll('tbody tr')).toHaveLength(rows)
}

describe('Sparkline dots', () => {
  const labels = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']
  // Day 1 is far outside the band with no verdict: the dot must stay the plain series colour,
  // because the verdict is the server's and nothing here compares a value with the band.
  const values = [120, 900, 150, 50, null, 130, 140]
  const standings: PointStanding[] = [null, null, 'above', 'below', null, 'within', null]

  function dotOption(over: { standings?: PointStanding[], dots?: boolean } = {}) {
    mount(<Sparkline values={values} labels={labels} label="steps" unit="steps" metric="steps"
      baseline={{ low: 100, high: 160 }} dots={over.dots ?? true} pointStandings={over.standings ?? standings} tableToggle={false} />)
    return seriesOf(lastOption).at(-1)!
  }

  it('colours a day by the server\'s standing, and the latest day in the primary text colour', () => {
    const series = dotOption()
    const colours = series.data.map((d) => (d === null ? null : (d as { itemStyle: { color: string } }).itemStyle.color))
    expect(colours).toEqual([SERIES, SERIES, NEGATIVE, NEGATIVE, null, SERIES, PRIMARY])
    expect(series.showSymbol).toBe(true)
  })

  it('draws the latest dot larger, rimmed in the card colour', () => {
    const series = dotOption()
    const sizes = series.data.map((d) => (d === null ? null : (d as { symbolSize: number }).symbolSize))
    expect(sizes.at(-1)).toBeGreaterThan(sizes[0]!)
    expect(new Set(sizes.slice(0, -1).filter((s) => s !== null)).size).toBe(1)
    expect((series.data.at(-1) as { itemStyle: { borderColor: string } }).itemStyle.borderColor).toBe(SURFACE)
  })

  it('takes the warning colour from the verdict alone, never from the band', () => {
    const series = dotOption({ standings: [null, null, null, null, null, null, null] })
    const colours = series.data.map((d) => (d === null ? null : (d as { itemStyle: { color: string } }).itemStyle.color))
    expect(colours).toEqual([SERIES, SERIES, SERIES, SERIES, null, SERIES, PRIMARY])
  })

  it('an outside verdict on the latest day wins over its highlight', () => {
    const series = dotOption({ standings: [null, null, null, null, null, null, 'above'] })
    expect((series.data.at(-1) as { itemStyle: { color: string } }).itemStyle.color).toBe(NEGATIVE)
  })

  it('without dots, hands echarts the plain values it always has', () => {
    const series = dotOption({ dots: false })
    expect(series.data).toEqual(values)
    expect(series.showSymbol).toBe(false)
  })

  it('without the visible control, keeps the table for assistive tech', () => {
    const host = mount(<Sparkline values={values} labels={labels} label="steps" unit="steps" metric="steps" tableToggle={false} />)
    expectTableForAssistiveTechOnly(host, 7)
  })

  // The colour alone is invisible to a screen reader, so the day's own verdict has to reach the
  // accessible table in words too, not just as a dot on the canvas.
  it('says a day\'s verdict in words in the accessible table, not by colour alone', () => {
    const host = mount(<Sparkline values={values} labels={labels} label="steps" unit="steps" metric="steps"
      baseline={{ low: 100, high: 160 }} dots pointStandings={standings} tableToggle={false} />)
    const rows = [...host.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].at(-1)?.textContent)
    expect(rows[2]).toBe('above your usual')
    expect(rows[3]).toBe('below your usual')
    // A day with no verdict ('within', or none at all) states nothing about it.
    expect(rows[0]).toBe('')
    expect(rows[5]).toBe('')
  })

  it('says nothing about a verdict when dots are off, even if the caller still passed one', () => {
    const host = mount(<Sparkline values={values} labels={labels} label="steps" unit="steps" metric="steps"
      dots={false} pointStandings={standings} tableToggle={false} />)
    const rows = [...host.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].at(-1)?.textContent)
    expect(rows.every((note) => note === '')).toBe(true)
  })
})

describe('Hypnogram, compact', () => {
  const MIN = 60_000
  const SEGMENTS = [
    { stage: 'light' as const, startMs: 0, endMs: 60 * MIN },
    { stage: 'awake' as const, startMs: 60 * MIN, endMs: 67 * MIN },
    { stage: 'deep' as const, startMs: 67 * MIN, endMs: 167 * MIN },
  ]

  function compact() {
    return mount(<Hypnogram segments={SEGMENTS} startLabel="Bed 23:10" startClock={-50} label="stages" compact />)
  }

  it('draws the stage blocks only: no axes, no lane labels, no bed label', () => {
    compact()
    const option = lastOption as { xAxis: { show?: boolean }, yAxis: { show?: boolean }, graphic: unknown[] }
    expect(option.xAxis.show).toBe(false)
    expect(option.yAxis.show).toBe(false)
    expect(option.graphic).toEqual([])
  })

  // Task 19b: the dashboard's night card asks for 112px instead of the compact default 96px when it
  // has the row to itself (span 12); the compact default itself stays 96 unless asked otherwise.
  it('grows to 112px when the card asks for the tall form, and stays 96 otherwise', () => {
    const plain = mount(<Hypnogram segments={SEGMENTS} startLabel="Bed 23:10" startClock={-50} label="stages" compact />)
    expect((plain.querySelector('[role="img"]') as HTMLElement).style.height).toBe('96px')
    const tall = mount(<Hypnogram segments={SEGMENTS} startLabel="Bed 23:10" startClock={-50} label="stages" compact tall />)
    expect((tall.querySelector('[role="img"]') as HTMLElement).style.height).toBe('112px')
  })

  it('ends in one faint line of totals, no awake note, and no visible control', () => {
    const host = compact()
    const totals = host.querySelectorAll('.hypnogram-totals')
    expect(totals).toHaveLength(1)
    expect(totals[0]!.className).toBe('hypnogram-totals is-compact')
    expect(totals[0]!.textContent).toBe('Deep 1h 40m · Light 1h 00m · Awake 0h 07m')
    expectTableForAssistiveTechOnly(host, 3)
  })
})

describe('IntradayHeartRate, compact', () => {
  const at = (utcMs: number, mean: number): IntradayPoint => ({ sourceId: 'watch', utcMs, min: mean - 5, mean, max: mean + 5, n: 1, excluded: false })
  const POINTS = [at(Date.UTC(2026, 8, 23, 4, 0), 58), at(Date.UTC(2026, 8, 23, 9, 38), 71)]
  const MIDNIGHT = localMidnightMs('2026-09-23', 'Europe/Amsterdam')
  const RUN = { startMs: Date.UTC(2026, 8, 23, 5, 15), endMs: Date.UTC(2026, 8, 23, 5, 47) }

  function compact() {
    return mount(<IntradayHeartRate points={POINTS} reduction={null} label="Heart rate today" compact startMs={MIDNIGHT} spans={[RUN]} />)
  }

  it('runs from local midnight to the last reading, with no axis drawn', () => {
    compact()
    const option = lastOption as { xAxis: { show?: boolean, min?: number, max?: number, axisLabel?: unknown }, yAxis: { show?: boolean, splitLine?: unknown } }
    expect(MIDNIGHT).toBe(Date.UTC(2026, 8, 22, 22, 0))
    expect(option.xAxis).toEqual({ type: 'time', show: false, min: MIDNIGHT, max: POINTS[1]!.utcMs })
    expect(option.yAxis).toEqual({ type: 'value', scale: true, show: false })
  })

  // A finished day: the axis ends at the next local midnight, whenever the last reading was.
  it('runs to endMs when given one, past the last reading', () => {
    const END = localMidnightMs('2026-09-24', 'Europe/Amsterdam')
    mount(<IntradayHeartRate points={POINTS} reduction={null} label="Heart rate that day" compact startMs={MIDNIGHT} endMs={END} />)
    const option = lastOption as { xAxis: { min?: number, max?: number } }
    expect(option.xAxis).toEqual({ type: 'time', show: false, min: MIDNIGHT, max: Date.UTC(2026, 8, 23, 22, 0) })
  })

  it('shades the workout span behind the trace', () => {
    compact()
    const shaded = seriesOf(lastOption).filter((s) => s.markArea !== undefined)
    expect(shaded).toHaveLength(1)
    expect(shaded[0]!.markArea!.data).toEqual([[{ xAxis: RUN.startMs }, { xAxis: RUN.endMs }]])
  })

  it('draws no visible control, and keeps the table for assistive tech', () => {
    expectTableForAssistiveTechOnly(compact(), 2)
  })
})

describe('localMidnightMs', () => {
  it('answers the zone\'s own midnight, on either side of a clock change', () => {
    expect(localMidnightMs('2026-09-23', 'UTC')).toBe(Date.UTC(2026, 8, 23))
    // Amsterdam goes back an hour at 03:00 on 25 October 2026: midnight is still summer time.
    expect(localMidnightMs('2026-10-25', 'Europe/Amsterdam')).toBe(Date.UTC(2026, 9, 24, 22, 0))
    expect(localMidnightMs('2026-10-26', 'Europe/Amsterdam')).toBe(Date.UTC(2026, 9, 25, 23, 0))
    expect(localMidnightMs('2026-09-23', 'America/New_York')).toBe(Date.UTC(2026, 8, 23, 4, 0))
  })
})
