// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: the option-capture tests below need a real mount
// (createRoot + act) so useChart's own useEffect actually runs and calls echarts.init, the same
// reason spo2-range.test.tsx and chart-marks.test.tsx give for their own files. The existing
// renderToStaticMarkup tests above run no effects and so never touch echarts at all regardless of
// which environment the file runs under.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { EChartsOption } from 'echarts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntradayHeartRate, intradayBasis, seriesBySource } from '../src/charts/IntradayHeartRate.js'
import type { IntradayPoint } from '../src/data/useIntraday.js'
import type { Translate } from '../src/format.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { I18nProvider } from '../src/i18n/index.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import type { NamedSource } from '../src/data/useSourceNames.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason spo2-range.test.tsx and chart-marks.test.tsx set them. Needed even though
// echarts.init itself is mocked below: build(currentChartTokens()) still runs before the mocked
// setOption ever sees its argument.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance useChart.ts creates, the same stub spo2-range.test.tsx
 * and chart-marks.test.tsx use for their own wiring tests, so `setOption`'s own argument (the
 * option this chart actually built) can be captured without a real canvas.
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

/**
 * Mounts IntradayHeartRate inside a QueryClientProvider whose client has the session and
 * sourceNamesKey('p1') seeded (the latter with `namedSources`, mirroring how control-row.test.tsx
 * seeds the same query so an unmocked fetch never runs in this environment), and returns the
 * ECharts option the mount actually built.
 *
 * `eventMarks` defaults to none: every existing caller of this helper wants the plain per-source
 * option, and only the series-order test below needs the appended events series at all.
 *
 * `metric` defaults to unset, matching every existing caller of this helper - Dashboard's own
 * heart_rate call site - so the component falls back to its own default; NightTraces.tsx's
 * spo2/hrv cards are the only reason this parameter exists at all (the "metric-specific
 * formatting" tests below).
 */
function optionForPoints(
  points: IntradayPoint[],
  namedSources: NamedSource[],
  eventMarks: readonly { atMs: number }[] = [],
  metric?: string,
): EChartsOption {
  const session: Session = {
    personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'UTC', connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), session)
  client.setQueryData(sourceNamesKey('p1'), { items: namedSources })
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <QueryClientProvider client={client}>
          <IntradayHeartRate points={points} reduction={null} label="Heart rate"
            eventMarks={eventMarks} metric={metric} />
        </QueryClientProvider>
      </I18nProvider>,
    )
  })
  const stub = chartStubs.at(-1)!
  return stub.setOption.mock.calls[0]![0] as EChartsOption
}

const at = (utcMs: number, sourceId: string, mean: number): IntradayPoint =>
  ({ sourceId, utcMs, min: mean - 5, mean, max: mean + 5, n: 1, excluded: false })

describe('seriesBySource', () => {
  // readIntraday pivots on source and minute together, because two devices can report the same
  // minute. A day with two devices must draw two lines: averaging them would invent a reading
  // neither device reported, and picking one would silently drop the other.
  it('splits a two source day into one series per source, keeping every point', () => {
    const points = [
      at(0, 'watch', 60), at(60000, 'watch', 62),
      at(0, 'phone', 70), at(60000, 'phone', 71),
    ]
    const series = seriesBySource(points)
    expect(series).toHaveLength(2)
    expect(series.flatMap((s) => s.points)).toHaveLength(4)
    const watch = series.find((s) => s.sourceId === 'watch')
    expect(watch?.points.map((p) => p.mean)).toEqual([60, 62])
  })

  // The single source case goes through the same code rather than a shortcut, so the two cases
  // cannot diverge.
  it('gives a one source day one series rather than a bare list', () => {
    const series = seriesBySource([at(0, 'watch', 60), at(60000, 'watch', 62)])
    expect(series).toHaveLength(1)
    expect(series[0]!.sourceId).toBe('watch')
  })

  // Points arrive ordered by minute per source, but the two sources interleave in the response.
  // A series whose points are out of order draws a line that doubles back on itself.
  it('keeps each series ordered by time when the sources interleave', () => {
    const points = [
      at(0, 'watch', 60), at(0, 'phone', 70),
      at(120000, 'watch', 64), at(60000, 'phone', 71), at(60000, 'watch', 62),
    ]
    const watch = seriesBySource(points).find((s) => s.sourceId === 'watch')!
    expect(watch.points.map((p) => p.utcMs)).toEqual([0, 60000, 120000])
  })

  it('answers an empty list for a day with no points, rather than one empty series', () => {
    expect(seriesBySource([])).toEqual([])
  })
})

// A stub, not a real i18n instance, the same device format.test.ts's own stubT uses for trend():
// intradayBasis only needs something call-shaped like `t`, and pinning one language's prose here
// would test a translator's wording rather than what intradayBasis itself decided to ask for.
function stubT(): { t: Translate, calls: [string, Record<string, unknown> | undefined][] } {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const t: Translate = (key, options) => {
    calls.push([key, options])
    return `t(${key})`
  }
  return { t, calls }
}

describe('intradayBasis', () => {
  // downsample.ts's own comment: reduction is null "so a client can tell 400 points that are the
  // whole series from 400 points standing in for 130,000". An object here is the other half of
  // that distinction: these points stand in for more than what is drawn, and the card has to say
  // how many samples were thinned and to what, not just that some thinning happened.
  it('states how many samples were thinned and to what, when reduction is an object', () => {
    const { t, calls } = stubT()
    intradayBasis(t, { method: 'minmax', from: 5700, to: 720 }, 720)
    expect(calls).toEqual([['charts.intradayBasis.thinned', { from: 5700, to: 720 }]])
  })

  // The other half: null means nothing was thinned, so the card has to say these points ARE the
  // readings, not stay silent about the one distinction reduction exists to draw.
  it('states these points are the readings, when reduction is null', () => {
    const { t, calls } = stubT()
    intradayBasis(t, null, 42)
    expect(calls).toEqual([['charts.intradayBasis.full', { count: 42 }]])
  })
})

describe('IntradayHeartRate time of day', () => {
  const SESSION: Session = {
    personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
  }
  // 20:00 UTC on an August day is 22:00 in Europe/Amsterdam (CEST, UTC+2). Picked to match the
  // exact case a UTC axis gets wrong: a two hour shift on a chart whose whole purpose is showing
  // when in the day something happened.
  const POINT: IntradayPoint =
    { sourceId: 'watch', utcMs: Date.UTC(2026, 7, 14, 20, 0, 0), min: 70, mean: 72, max: 75, n: 1, excluded: false }

  function renderTable(session: Session | undefined): string {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Mirrors page-controls.test.tsx's own withQuery: setQueryData seeds the cache synchronously,
    // so useSession() resolves without a real fetch or an effect ever running, which is what
    // renderToStaticMarkup needs (it runs no effects at all).
    if (session !== undefined) client.setQueryData(queryKeys.session(), session)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">
          <IntradayHeartRate points={[POINT]} reduction={null} label="Heart rate" />
        </I18nProvider>
      </QueryClientProvider>,
    )
    return html.match(/<table class="sr-only">[\s\S]*?<\/table>/)![0]
  }

  // The point of this task's fix: IntradayPoint carries no recording offset (readIntraday.ts's own
  // reason not to try to recover one), but the reader's own configured zone is a different, known
  // quantity, the same one usePageControls already reads off the session to compute "the person's
  // today, not the browser's". A chart that ignored it and rendered UTC unconditionally would be
  // wrong by the reader's own offset, all day, on the one axis and table this chart exists to draw.
  it("renders a point's time of day in the session's own timezone, not UTC", () => {
    const table = renderTable(SESSION)
    expect(table).toContain('22:00')
    expect(table).not.toContain('20:00')
  })

  // The other half of the same fix: a reader has an instant to show regardless of whether
  // /api/auth/me has answered yet, and UTC is a real, statable zone to fall back to rather than a
  // guess (unlike the runtime's own machine zone, which is what usePageControls itself falls back
  // to for a different question - "the person's today" - and is not this chart's own choice to
  // repeat here on purpose: see timeOfDay's own comment).
  it('falls back to UTC rather than throwing while the session has not loaded yet', () => {
    const table = renderTable(undefined)
    expect(table).toContain('20:00')
  })
})

describe('source names in the intraday heart rate chart', () => {
  it('names the mean series with the name, and keeps the stack keyed by id', () => {
    // Two points from one source, rendered with an alias set for it.
    const option = optionForPoints(
      [{ utcMs: 0, sourceId: 'src-hex-id', min: 50, mean: 60, max: 70, n: 1, excluded: false }],
      [{ id: 'src-hex-id', externalId: 'x', displayName: 'Pixel Watch 4', alias: 'My watch', name: 'My watch', kind: 'device', createdAtMs: 0 }],
    )
    const series = option.series as { name: string, stack?: string }[]
    expect(series.map((s) => s.name)).toEqual(['My watch min', 'My watch range', 'My watch'])
    // The stack is the part a rename must not touch: two sources' bands are drawn independently
    // because their stack keys differ, and a stack keyed by a name two sources can share would
    // silently pile one source's range on top of another's.
    expect(series.map((s) => s.stack)).toEqual(['range-src-hex-id', 'range-src-hex-id', undefined])
  })

  it('falls back to the id when no names are loaded', () => {
    const option = optionForPoints(
      [{ utcMs: 0, sourceId: 'src-hex-id', min: 50, mean: 60, max: 70, n: 1, excluded: false }],
      [],
    )
    expect((option.series as { name: string }[]).map((s) => s.name))
      .toEqual(['src-hex-id min', 'src-hex-id range', 'src-hex-id'])
  })

  it('still finds the hovered point after a rename', () => {
    const option = optionForPoints(
      [{ utcMs: 0, sourceId: 'src-hex-id', min: 50, mean: 60, max: 70, n: 1, excluded: false }],
      [{ id: 'src-hex-id', externalId: 'x', displayName: 'Pixel Watch 4', alias: 'My watch', name: 'My watch', kind: 'device', createdAtMs: 0 }],
    )
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter
    // seriesIndex 2 is the mean line: three series per source, mean last.
    const html = formatter([{ seriesName: 'My watch', seriesIndex: 2, dataIndex: 0 }])
    expect(html).toContain('My watch')
    expect(html).not.toContain('src-hex-id')
  })
})

// Task 6 review finding: every formatMetricValue call in IntradayHeartRate.tsx and both
// charts.hrTooltip catalogue strings were hardcoded to heart_rate, so an spo2 or hrv trace
// (NightTraces.tsx, the reason this chart takes a `metric` prop at all) rendered at heart rate's
// own precision (0 decimals) and said "bpm" in the tooltip and the accessible table regardless of
// what it was actually showing. spo2's own catalogue entry (packages/core/src/derive/metrics.ts)
// is precision 1, unit percent - the case this section pins.
describe('IntradayHeartRate formats by its own metric, not always heart_rate', () => {
  // Every field given its own non-integer value, rounding in different directions, so a fix that
  // only handled one of the three (or only the tooltip, or only the table) would not pass this.
  const SPO2_POINT: IntradayPoint =
    { sourceId: 'watch', utcMs: 0, min: 94.24, mean: 96.5, max: 98.71, n: 1, excluded: false }

  it("rounds to spo2's own precision and names its own unit in the tooltip, not heart rate's", () => {
    const option = optionForPoints([SPO2_POINT], [], [], 'spo2')
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter
    const html = formatter([{ seriesIndex: 2, dataIndex: 0 }])
    // spo2's own precision (one decimal) and unit ("%") - heart_rate's own precision (zero
    // decimals) and "bpm" would instead read "mean 97 bpm" and "range 94 to 99 bpm" here.
    expect(html).toContain('mean 96.5 %')
    expect(html).toContain('range 94.2 to 98.7 %')
  })

  it("rounds the accessible table to spo2's own precision too, not just the tooltip", () => {
    optionForPoints([SPO2_POINT], [], [], 'spo2')
    const table = container!.querySelector('table.sr-only')!
    // Row cells after the row header (time, rendered as <th scope="row">): source, minimum, mean,
    // maximum, note, in that order (IntradayHeartRate.tsx's own `rows` builder).
    const cells = [...table.querySelectorAll('td')].map((td) => td.textContent)
    expect(cells[1]).toBe('94.2')
    expect(cells[2]).toBe('96.5')
    expect(cells[3]).toBe('98.7')
  })

  it('still rounds to heart_rate\'s own precision and says "bpm" when no metric is given', () => {
    // Dashboard's own call site never names a metric - this is the default this whole fix must
    // not disturb.
    const option = optionForPoints(
      [{ sourceId: 'watch', utcMs: 0, min: 55, mean: 60.4, max: 65, n: 1, excluded: false }], [],
    )
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter
    expect(formatter([{ seriesIndex: 2, dataIndex: 0 }])).toContain('mean 60 bpm')
  })
})

// Task 4 review finding: Step 7 of the plan claimed this file and chart-marks.test.tsx already
// proved the appended events series left the 3i+2 lookups alone, but neither actually passed
// eventMarks - both only ever exercised the empty ("no series appended") arm. This is the missing
// non-empty case.
describe('the appended events series does not move the per-source series-index lookups', () => {
  it('still resolves a two source tooltip to the right source and reading after an events series is appended', () => {
    const option = optionForPoints(
      [
        { utcMs: 0, sourceId: 'watch', min: 50, mean: 60, max: 70, n: 1, excluded: false },
        { utcMs: 0, sourceId: 'phone', min: 90, mean: 100, max: 110, n: 1, excluded: false },
      ],
      [],
      [{ atMs: 30_000 }],
    )
    const series = option.series as { name: string, markLine?: unknown }[]
    // Three series per source (min, range, mean) plus one appended events series: 7 total. Mean
    // lines sit at indices 2 (watch) and 5 (phone) - the `3i + 2` contract pointsBySeriesIndex and
    // excludedBySeriesIndex both depend on - and the events series is last, at index 6.
    expect(series).toHaveLength(7)
    expect(series[6]!.markLine).toBeDefined()

    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter
    // seriesIndex 2 is watch's mean line; seriesIndex 5 is phone's. Resolving each must still
    // report its own source and its own mean, not the other's and not nothing, which is exactly
    // what would happen if appending the events series had shifted either index.
    const watchHtml = formatter([{ seriesName: 'watch', seriesIndex: 2, dataIndex: 0 }])
    const phoneHtml = formatter([{ seriesName: 'phone', seriesIndex: 5, dataIndex: 0 }])
    expect(watchHtml).toContain('watch')
    expect(watchHtml).toContain('mean 60 bpm')
    expect(phoneHtml).toContain('phone')
    expect(phoneHtml).toContain('mean 100 bpm')
  })
})
