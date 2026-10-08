// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import * as echarts from 'echarts/core'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { HeartRateCard } from '../src/pages/recovery/HeartRateCard.js'
import { hrTooltip } from '../src/charts/hrTooltip.js'
import { Recovery } from '../src/pages/Recovery.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush, pumpUntil } from './flush.js'
import { seriesPoint } from './metricCoverage.js'
import { RECOVERY_PERIOD_MONTH } from './fixtures/recoveryPeriod.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'

// Same reason dashboard-cards.test.tsx needs this: HeartRateRange draws for real here, and
// echarts.init's effect throws "missing chart token" without it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

type Baseline = { center: number, spread: number, n: number, thin: boolean } | null

const RANGE_DATES = ['2026-08-14', '2026-08-15', '2026-08-16']

/** The month-shaped default props every test below starts from, overridable per case. */
const DEFAULT_PROPS = {
  from: '2026-08-14', to: '2026-08-16', historicalTo: '2026-08-16', source: ALL_SOURCES,
  rangeDates: RANGE_DATES, range: 'month' as const, period: '2026-08-14 to 2026-08-16', periodWords: 'this month',
  annotations: [], excluded: [], onDayClick: () => {}, span: 8,
}

/**
 * Answers every route HeartRateCard calls, mirroring dashboard-cards.test.tsx's own stubFetch
 * (this card used to be part of that page and drew from the same routes): the session, /series
 * for heart_rate under mean/min/max, and /baselines.
 */
function stubFetch(opts: { baseline: Baseline, hangBaselines?: boolean, asked?: string[], dates?: string[] }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    opts.asked?.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: (opts.dates ?? ['2026-08-15']).map((date) => seriesPoint(metric, date, 60)), reduction: null }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      if (opts.hangBaselines === true) return new Promise<Response>(() => {})
      return new Response(JSON.stringify({ baseline: opts.baseline }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/sync/status')) {
      return new Response(JSON.stringify({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the heart rate range band', () => {
  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no baseline band when the baseline is thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 3, thin: true } })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws the band when the baseline is not thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 28, thin: false } })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // The principle heartRateBasisKey's own comment states: "no baseline yet" is a claim about the
  // person's history, and an unanswered request makes no such claim. MetricCard gates the card on
  // the three heart rate series, /baselines settles separately, so the card draws while this one
  // is still in flight and the null branch spoke for it.
  it('does not claim there is no baseline while the baseline request is in flight', async () => {
    const restore = stubFetch({ baseline: null, hangBaselines: true })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // Gated on the basis line, not on the card's label: the pending branch renders the label too,
    // so waiting for "Heart rate range" can go true a tick before any basis exists.
    await pumpUntil(
      () => container!.textContent!.includes('daily minimum, mean and maximum'),
      'the heart rate range basis line',
    )
    const text = container!.textContent!
    expect(text).toContain('your usual range is still loading')
    expect(text).not.toContain('no usual range yet')
    restore()
  })

  // M3 phase review B2: the band is computed against historicalTo, not the range's own future end.
  // The caption names no date any more (it says what the band is, as the page's other captions do),
  // so the guard holds the request itself to that anchor.
  it('asks for the band at historicalTo, not the end of the range, and captions it under the chart', async () => {
    const asked: string[] = []
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false }, asked })
    const { client, tree } = withQuery(
      <HeartRateCard {...DEFAULT_PROPS} to="2026-09-30" historicalTo="2026-09-05" />,
    )
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const baselines = asked.filter((url) => url.includes('/baselines'))
    expect(baselines.length).toBeGreaterThan(0)
    expect(baselines.every((url) => url.includes('on=2026-09-05'))).toBe(true)
    // Under the chart, as a caption, and no basis line in the card's header.
    expect(container!.querySelector('.basis')).toBeNull()
    const caption = container!.querySelector('.card .dash-caption')
    expect(caption?.textContent).toBe('daily minimum, mean and maximum, every day this month · band = your usual range')
    // After the chart in the card, not above it.
    const chart = container!.querySelector('.card [role="img"]')!
    expect(chart.compareDocumentPosition(caption!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    restore()
  })

  it('words its caption in Dutch', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false } })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} periodWords="deze maand" />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('.card .dash-caption')?.textContent)
      .toBe('dagelijks minimum, gemiddelde en maximum, elke dag deze maand · band = je gebruikelijke bereik')
    restore()
  })
})

describe('mounted on Recovery', () => {
  const NO_REBUILD = NO_REBUILD_NEWS

  function stubRecovery(): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/recovery/period')) return json(RECOVERY_PERIOD_MONTH)
      if (url.includes('/series')) {
        const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
        const body: Record<string, unknown> = {}
        for (const metric of metrics) body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
        return json(body)
      }
      if (url.includes('/baselines')) return json({ baseline: null })
      if (url.includes('/notes')) return json({ items: [{ id: 'n1', localDate: '2026-08-15', body: 'Slept at a friend', updatedAtMs: 0 }] })
      if (url.includes('/events')) {
        return json({ items: [{
          id: 'e1', kind: 'caffeine', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
          endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-15',
        }] })
      }
      if (url.includes('/overrides')) return json({ items: [] })
      if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD })
      return json({})
    }) as typeof fetch
    return () => { globalThis.fetch = original }
  }

  // Recovery mounts the card the old Dashboard drew at its own foot, across the whole row of the
  // overview's grid. Its Day tab draws no trace: it opens the dashboard on that day
  // (recovery.test.tsx), and the dashboard's day carries the trace.
  it('shows a card labelled Heart rate range, the whole row wide', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery()
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll<HTMLElement>('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')
    expect(card?.dataset.span).toBe('12')
    restore()
  })

  // The overview pages draw no day notes or events on their charts: on a year they piled into one
  // unreadable block. Notes and events stay reachable from the hero's day panel.
  it('draws no day note or event on the range, and captions it by the period', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery()
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll<HTMLElement>('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Heart rate range')!
    expect(card.querySelector('table')).not.toBeNull()
    expect(card.innerHTML).not.toContain('Slept at a friend')
    expect(card.innerHTML).not.toContain('Caffeine')
    expect(card.querySelector('.dash-caption')?.textContent)
      .toBe('daily minimum, mean and maximum, every day this month · no usual range yet')
    restore()
  })
})

/** Every date from `from` to `to`, both included. */
function datesFrom(from: string, to: string): string[] {
  const dates: string[] = []
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10))
  }
  return dates
}

/** Answers the phone query, so a chart that takes taps renders its annotate control (chart-annotate-handlers.test.tsx). */
function pretendPhone(): () => void {
  const real = window.matchMedia.bind(window)
  window.matchMedia = ((query: string) => {
    if (query !== PHONE_MEDIA_QUERY) return real(query)
    return {
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
  return () => { window.matchMedia = real }
}

type DrawnOption = {
  xAxis: { data: string[], axisLabel: { interval: (index: number) => boolean } }[]
  series: { name: string, data: (number | null)[] }[]
}
const option = (): DrawnOption =>
  echarts.getInstanceByDom(container!.querySelector<HTMLDivElement>('.card div[role="img"]')!)!.getOption() as unknown as DrawnOption
const meanDrawn = () => option().series.find((series) => series.name === 'mean')!.data
// The x labels the axis prints (periodAxisLabels' `shown`).
const xLabels = (): string[] => {
  const axis = option().xAxis[0]!
  return axis.data.filter((_, index) => axis.axisLabel.interval(index))
}
const tableRows = (): string[][] => [...container!.querySelectorAll('.card table tbody tr')]
  .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''))
const tableHead = (): string[] => [...container!.querySelectorAll('.card table thead th')].map((cell) => cell.textContent ?? '')

describe('the heart rate range by the range', () => {
  const YEAR = datesFrom('2025-01-01', '2025-12-31')
  const AUGUST = datesFrom('2026-08-01', '2026-08-31')
  const yearProps = {
    ...DEFAULT_PROPS, from: '2025-01-01', to: '2025-12-31', historicalTo: '2025-12-31',
    rangeDates: YEAR, range: 'year' as const, period: '2025-01-01 to 2025-12-31', periodWords: 'this year',
  }
  const monthProps = {
    ...DEFAULT_PROPS, from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31', rangeDates: AUGUST,
  }

  it('draws a point a week on a year, under month names, and words its table by the week', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false }, dates: YEAR.filter((date) => date < '2025-12-01') })
    const { client, tree } = withQuery(<HeartRateCard {...yearProps} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(meanDrawn()).toHaveLength(53)
    // December has no readings: its weeks are gaps, not the last value carried on.
    expect(meanDrawn().at(-1)).toBeNull()
    expect(meanDrawn()[0]).toBe(60)
    expect(xLabels()).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
    expect(tableHead()[0]).toBe('Week')
    expect(tableRows()).toHaveLength(53)
    expect(tableRows()[0]![0]).toBe('2025-01-01 – 2025-01-05')
    expect(tableRows()[1]![0]).toBe('2025-01-06 – 2025-01-12')
    expect(container!.querySelector('.card .dash-caption')?.textContent)
      .toBe('every week: its lowest daily minimum, the average of its days and its highest daily maximum · band = your usual range')
    restore()
  })

  it('draws a point a week on 3 months too', async () => {
    const quarter = datesFrom('2026-07-01', '2026-09-30')
    const restore = stubFetch({ baseline: null, dates: quarter })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} from="2026-07-01" to="2026-09-30" historicalTo="2026-09-30"
      rangeDates={quarter} range="3months" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    // Wed 1 Jul to Wed 30 Sep: a clipped week at each end and twelve whole ones between.
    expect(meanDrawn()).toHaveLength(14)
    expect(xLabels()).toEqual(['Jul', 'Aug', 'Sep'])
    restore()
  })

  it('draws a point a day on a month, its axis day numbers every seventh day', async () => {
    const restore = stubFetch({ baseline: null, dates: AUGUST })
    const { client, tree } = withQuery(<HeartRateCard {...monthProps} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(meanDrawn()).toHaveLength(31)
    expect(xLabels()).toEqual(['1', '8', '15', '22', '29'])
    expect(tableHead()[0]).toBe('Date')
    expect(tableRows()[0]![0]).toBe('2026-08-01')
    restore()
  })

  it('names the days of a week by weekday', async () => {
    const week = datesFrom('2026-08-10', '2026-08-16')
    const restore = stubFetch({ baseline: null, dates: week })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} from="2026-08-10" to="2026-08-16" rangeDates={week} range="week" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(meanDrawn()).toHaveLength(7)
    expect(xLabels()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    restore()
  })

  it('opens a day from a month point, and nothing from a week point on a year', async () => {
    const realPhone = pretendPhone()
    try {
      const restoreMonth = stubFetch({ baseline: null, dates: AUGUST })
      const month = withQuery(<HeartRateCard {...monthProps} />)
      mount(<I18nProvider lng="en">{month.tree}</I18nProvider>)
      await flush(month.client, () => container!.innerHTML)
      expect(container!.querySelector('.chart-annotate')).not.toBeNull()
      restoreMonth()

      const restoreYear = stubFetch({ baseline: null, dates: YEAR })
      const year = withQuery(<HeartRateCard {...yearProps} />)
      mount(<I18nProvider lng="en">{year.tree}</I18nProvider>)
      await flush(year.client, () => container!.innerHTML)
      expect(meanDrawn()).toHaveLength(53)
      expect(container!.querySelector('.chart-annotate')).toBeNull()
      restoreYear()
    } finally {
      realPhone()
    }
  })

  it('draws no exclusion or note on a week, and names an excluded day on a month', async () => {
    const restore = stubFetch({ baseline: null, dates: YEAR })
    const { client, tree } = withQuery(<HeartRateCard {...yearProps} excluded={['2025-03-04']}
      annotations={[{ date: '2025-03-04', text: 'Bad strap' }]} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(tableRows()).toHaveLength(53)
    expect(container!.querySelector('.card table')!.textContent).not.toContain('excluded')
    expect(container!.querySelector('.card table')!.textContent).not.toContain('Bad strap')
    restore()

    const restoreMonth = stubFetch({ baseline: null, dates: AUGUST })
    const month = withQuery(<HeartRateCard {...monthProps} excluded={['2026-08-04']} />)
    mount(<I18nProvider lng="en">{month.tree}</I18nProvider>)
    await flush(month.client, () => container!.innerHTML)
    expect(tableRows().find((row) => row[0] === '2026-08-04')!.at(-1)).toBe('excluded')
    restoreMonth()
  })

  it('words the weekly caption in Dutch', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 5, n: 60, thin: false }, dates: YEAR })
    const { client, tree } = withQuery(<HeartRateCard {...yearProps} periodWords="dit jaar" />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('.card .dash-caption')?.textContent)
      .toBe('elke week: het laagste dagminimum, het gemiddelde van haar dagen en het hoogste dagmaximum · band = je gebruikelijke bereik')
    restore()
  })
})

describe('the heart rate range toggle', () => {
  const YEAR = datesFrom('2025-01-01', '2025-12-31')
  const QUARTER = datesFrom('2026-07-01', '2026-09-30')
  const AUGUST = datesFrom('2026-08-01', '2026-08-31')
  const toggle = () => container!.querySelector<HTMLButtonElement>('.card button[aria-pressed]')!
  const cases = [
    { range: 'year' as const, dates: YEAR, lng: 'en', hide: 'Hide weekly range', show: 'Show weekly range' },
    { range: 'year' as const, dates: YEAR, lng: 'nl', hide: 'Weekbereik verbergen', show: 'Weekbereik tonen' },
    { range: '3months' as const, dates: QUARTER, lng: 'en', hide: 'Hide weekly range', show: 'Show weekly range' },
    { range: '3months' as const, dates: QUARTER, lng: 'nl', hide: 'Weekbereik verbergen', show: 'Weekbereik tonen' },
    { range: 'month' as const, dates: AUGUST, lng: 'en', hide: 'Hide daily range', show: 'Show daily range' },
    { range: 'month' as const, dates: AUGUST, lng: 'nl', hide: 'Dagbereik verbergen', show: 'Dagbereik tonen' },
  ]
  for (const c of cases) {
    it(`says "${c.hide}" then "${c.show}" on ${c.range} in ${c.lng}`, async () => {
      const restore = stubFetch({ baseline: null, dates: c.dates })
      const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} from={c.dates[0]!} to={c.dates.at(-1)!}
        historicalTo={c.dates.at(-1)!} rangeDates={c.dates} range={c.range} />)
      mount(<I18nProvider lng={c.lng}>{tree}</I18nProvider>)
      await flush(client, () => container!.innerHTML)
      expect(toggle().textContent).toBe(c.hide)
      act(() => { toggle().click() })
      expect(toggle().textContent).toBe(c.show)
      restore()
    })
  }
})

describe('the weekly tooltip', () => {
  it('heads hrTooltip with the span it is handed in place of the day', () => {
    const t = ((key: string) => key) as Parameters<typeof hrTooltip>[2]
    const week = { date: '2025-01-06', to: '2025-01-12', steps: null, sleepMinutes: null, hrMin: 50, hrMean: 60, hrMax: 120, worn: true }
    expect(hrTooltip([week], 0, t, 'en', '2025-01-06 – 2025-01-12').startsWith('2025-01-06 – 2025-01-12<br/>')).toBe(true)
    expect(hrTooltip([week], 0, t, 'en').startsWith('2025-01-06<br/>')).toBe(true)
  })

  it('names a week on a year by its first and last day, and a day on a month by its date', async () => {
    const YEAR = datesFrom('2025-01-01', '2025-12-31')
    const tooltipAt = (dataIndex: number): string => {
      const instance = echarts.getInstanceByDom(container!.querySelector<HTMLDivElement>('.card div[role="img"]')!)!
      const { tooltip } = instance.getOption() as unknown as { tooltip: { formatter: (params: unknown) => string }[] }
      return tooltip[0]!.formatter([{ componentType: 'series', dataIndex }])
    }
    const restore = stubFetch({ baseline: null, dates: YEAR })
    const { client, tree } = withQuery(<HeartRateCard {...DEFAULT_PROPS} from="2025-01-01" to="2025-12-31" historicalTo="2025-12-31"
      rangeDates={YEAR} range="year" />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(tooltipAt(1).startsWith('2025-01-06 – 2025-01-12<br/>')).toBe(true)
    restore()

    const AUGUST = datesFrom('2026-08-01', '2026-08-31')
    const restoreMonth = stubFetch({ baseline: null, dates: AUGUST })
    const month = withQuery(<HeartRateCard {...DEFAULT_PROPS} from="2026-08-01" to="2026-08-31" historicalTo="2026-08-31" rangeDates={AUGUST} />)
    mount(<I18nProvider lng="en">{month.tree}</I18nProvider>)
    await flush(month.client, () => container!.innerHTML)
    expect(tooltipAt(3).startsWith('2026-08-04<br/>')).toBe(true)
    restoreMonth()
  })
})
