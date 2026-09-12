// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, for the reason chart-marks.test.tsx and
// spo2-range.test.tsx both give for their own copies of this header: a tooltip formatter is a
// function echarts only ever calls on a real hover, so the only way to reach it is to mount the
// chart for real (createRoot + act), let useChart's useEffect run, and read the formatter off the
// mocked instance's own setOption argument. The accessible tables these tests compare against are
// read from the same mount's DOM, so both channels come off one render rather than each off its
// own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HeartRateRange } from '../src/charts/HeartRateRange.js'
import { Spo2Range } from '../src/charts/Spo2Range.js'
import { ActivityHeatmap } from '../src/charts/ActivityHeatmap.js'
import { IntradayHeartRate } from '../src/charts/IntradayHeartRate.js'
import type { IntradayPoint } from '../src/data/useIntraday.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { DayRow } from '../src/fixtures/july.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import type { NamedSource } from '../src/data/useSourceNames.js'
import type { Session } from '../src/auth/session.js'

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

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
 * An annotation a member of the household could actually type, carrying every character an HTML
 * escape has to deal with: `<` and `>` (the tag itself), `&` (so a correct escape cannot simply
 * be a pair of replacements that corrupt an ampersand), and both quote characters (which React's
 * own text escaping rewrites, and which the parity assertions below therefore depend on).
 *
 * The `onerror` is the point: echarts renders a tooltip formatter's return value as HTML, so an
 * unescaped copy of this string is not text a reader sees, it is a script that runs when they
 * hover the day it was written on.
 */
const MARKUP = `<img src="x" onerror='alert(1)'> & sons`

/**
 * The tooltip string as a browser actually builds it, so every assertion below is about what a
 * reader ends up looking at rather than about a particular spelling of an escape.
 *
 * This matters more than it first looks. The accessible table is serialised by React and the
 * tooltip by these formatters, and the two do NOT agree character for character even when both
 * are correct: React's own text escaping rewrites both quote characters, the DOM's does not.
 * Asserting on escaped strings would therefore pin the renderer, not the behaviour. Parsing both
 * channels back into text asserts the one property the chart styling document actually binds --
 * that they say the same thing about the same day -- and leaves the escape free to spell itself
 * however it likes.
 */
function parse(tooltip: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = tooltip
  return host
}

/** The `<td>` cells of a row, read as text off the live DOM rather than off serialised markup. */
function cellsFor(rowHeader: string): string[] {
  const rows = [...container!.querySelectorAll('table.sr-only tr')]
  const row = rows.find((r) => r.querySelector('th')?.textContent === rowHeader)
  if (!row) throw new Error(`no row for ${rowHeader}`)
  return [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
}

/** The note column, which is the rightmost one on all three day level charts. */
function noteCellFor(date: string): string {
  const last = cellsFor(date).at(-1)
  if (last === undefined) throw new Error(`no cells in row for ${date}`)
  return last
}

function tooltipFormatter(): (params: unknown) => string {
  const stub = chartStubs.at(-1)!
  const option = stub.setOption.mock.calls[0]![0] as { tooltip?: { formatter?: (p: unknown) => string } }
  const formatter = option.tooltip?.formatter
  if (!formatter) throw new Error('the chart built no tooltip formatter')
  return formatter
}

const DAY = (date: string, over: Partial<DayRow> = {}): DayRow =>
  ({ date, steps: 4000, hrMin: 55, hrMean: 62, hrMax: 90, sleepMinutes: 420, worn: true, ...over })

describe('a day level chart tooltip', () => {
  // The three charts that draw a markLine/markPoint tooltip carrying annotation text. Each is
  // mounted with one annotation on the middle day and nothing excluded, so the mark this test
  // hovers is the annotation's own and its dataIndex is 0 on every one of them.
  const dates = ['2026-08-01', '2026-08-02', '2026-08-03']
  const mounts = {
    HeartRateRange: (text: string) => {
      act(() => {
        root!.render(
          <I18nProvider lng="en">
            <HeartRateRange days={dates.map((d) => DAY(d))} label="Heart rate"
              annotations={[{ date: '2026-08-02', text }]} excluded={[]} />
          </I18nProvider>,
        )
      })
      return { params: { componentType: 'markLine', dataIndex: 0 } }
    },
    Spo2Range: (text: string) => {
      act(() => {
        root!.render(
          <I18nProvider lng="en">
            <Spo2Range days={dates.map((date) => ({ date, min: 94, mean: 96, max: 99, count: 400 }))}
              label="SpO2" annotations={[{ date: '2026-08-02', text }]} excluded={[]} />
          </I18nProvider>,
        )
      })
      return { params: { componentType: 'markLine', dataIndex: 0 } }
    },
    ActivityHeatmap: (text: string) => {
      act(() => {
        root!.render(
          <I18nProvider lng="en">
            <ActivityHeatmap days={dates.map((d) => DAY(d))} max={10000} label="Steps"
              annotations={[{ date: '2026-08-02', text }]} excluded={[]} />
          </I18nProvider>,
        )
      })
      return { params: { componentType: 'markPoint', dataIndex: 0 } }
    },
  }

  for (const [name, mount] of Object.entries(mounts)) {
    describe(name, () => {
      it('renders a note containing markup as text, never as live markup', () => {
        const { params } = mount(MARKUP)
        const rendered = parse(tooltipFormatter()(params))
        // The actual security property, asserted the way a browser settles it rather than by
        // looking for a substring: echarts writes this string into the tooltip element as HTML,
        // so if anything here still parses as an element, that element is one the household's own
        // note built and its onerror is one the browser runs on hover.
        expect(rendered.querySelector('img')).toBeNull()
        // ...and the note still reaches the reader, in full. An escape that dropped the text
        // instead of neutralising it would pass the check above and lose what the day says.
        expect(rendered.textContent).toContain(MARKUP)
      })

      it('says exactly what its own accessible table row says about that day', () => {
        const { params } = mount(MARKUP)
        const rendered = parse(tooltipFormatter()(params))
        // Asserted against the note cell from the SAME render rather than against a second
        // literal, the idiom chart-marks.test.tsx states for the canvas/table pair: two strings
        // that happen to agree today prove nothing about tomorrow. This is the property the chart
        // styling document binds, and the one the defect broke -- not because the table was wrong,
        // but because the tooltip stopped being text at all while the table stayed text.
        expect(rendered.textContent).toBe(`2026-08-02${noteCellFor('2026-08-02')}`)
      })

      it('leaves an ordinary note untouched, so escaping costs a plain reader nothing', () => {
        // The other half of the behaviour, and the one a too-eager escape breaks: a note with no
        // special characters must come out byte for byte, not double-escaped into visible
        // `&amp;lt;` and not re-encoded.
        const { params } = mount('Flew to Tokyo')
        expect(tooltipFormatter()(params)).toBe('2026-08-02<br/>Flew to Tokyo')
      })
    })
  }
})

describe('IntradayHeartRate tooltip', () => {
  // The second reader-authored channel, and the one that is not an annotation: a source's `name`
  // is its per-person alias when the household has set one (useSourceNames.ts), so a device
  // renamed to something containing markup reaches this formatter exactly the way a note does.
  const POINT: IntradayPoint =
    { sourceId: 's1', utcMs: Date.UTC(2026, 7, 14, 9, 0), min: 55, mean: 60, max: 65, n: 1, excluded: false }

  function mount(sourceName: string) {
    const session: Session = {
      personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'UTC',
      connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
    }
    const sources: NamedSource[] = [{
      id: 's1', externalId: 'x1', displayName: 'Watch', alias: sourceName, name: sourceName,
      kind: 'device', createdAtMs: 0,
    }]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), session)
    client.setQueryData(sourceNamesKey('p1'), { items: sources })
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <QueryClientProvider client={client}>
            <IntradayHeartRate points={[POINT]} reduction={null} label="Heart rate" />
          </QueryClientProvider>
        </I18nProvider>,
      )
    })
  }

  it('renders a source name containing markup as text, never as live markup', () => {
    mount(MARKUP)
    const rendered = parse(tooltipFormatter()([{ componentType: 'series', seriesIndex: 2, dataIndex: 0 }]))
    expect(rendered.querySelector('img')).toBeNull()
    expect(rendered.textContent).toContain(MARKUP)
  })

  it('names the source the same way its own accessible table row does', () => {
    mount(MARKUP)
    const rendered = parse(tooltipFormatter()([{ componentType: 'series', seriesIndex: 2, dataIndex: 0 }]))
    // The source column is the first `<td>`: this table's row header is the time, not a date.
    expect(rendered.textContent).toContain(`09:00 ${cellsFor('09:00')[0]}`)
  })

  it('keeps the line breaks that separate a reading from the next', () => {
    // Structural markup the formatter writes itself, as against text it interpolates: escaping
    // the one must not eat the other, which is the failure mode an over-broad escape (running
    // over the assembled string instead of over each interpolated value) would have.
    mount('Watch')
    expect(parse(tooltipFormatter()([{ componentType: 'series', seriesIndex: 2, dataIndex: 0 }]))
      .querySelectorAll('br').length).toBeGreaterThan(0)
  })
})
