// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
// The same entry point useChart.ts initialises charts through, so getInstanceByDom below finds the
// instance that file created rather than looking in a second, unrelated registry.
import * as echarts from 'echarts/core'
import { Sleep } from '../src/pages/Sleep.js'
import { nightPath } from '../src/pages/sleep/NightRow.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { axisTickInterval, WIDE_WINDOW } from '../src/charts/schedule.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { PeriodFigure, SleepListRow, SleepPeriodData } from '../src/data/periodTypes.js'
import { SLEEP_PERIOD_EMPTY, SLEEP_PERIOD_MONTH, SLEEP_PERIOD_YEAR } from './fixtures/sleepPeriod.js'
import { stubSleep, withQuery } from './sleepPageStub.js'
import type { SleepStub } from './sleepPageStub.js'
import { flush } from './flush.js'
import { seriesPoint } from './metricCoverage.js'

// The hero's and the figure rows' strips, stubbed so a test can read what each was handed and click
// a dot the way the chart would (period-hero.test.tsx's own idiom). Keyed by the chart's label.
type SparklineProps = { label: string, values: (number | null)[], lastYear?: (number | null)[], onPointClick?: (label: string) => void }
const { sparklines } = vi.hoisted(() => ({ sparklines: new Map<string, SparklineProps>() }))
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: SparklineProps) => {
    sparklines.set(props.label, props)
    return <div data-sparkline={props.label} />
  },
}))

// SleepSchedule, BalanceBars and StackedDailyBars draw for real, and echarts.init throws "missing
// chart token" without these.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null
// Restored after the unmount rather than straight after the flush: a panel opened late in a test
// (the AnnotatePanel) still asks for things, and those must not reach a real network.
let restore: () => void = () => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sparklines.clear()
})

afterEach(() => {
  act(() => { root?.unmount() })
  restore()
  restore = () => {}
  container?.remove()
  container = null
  root = null
})

const MONTH_URL = '/sleep?range=month&on=2026-08-15'
const YEAR_URL = '/sleep?range=year&on=2025-06-01'

/** Mounts the page at `path` over `stub`, settled; returns every URL it asked for. */
async function renderAt(path: string, stub: SleepStub, lng = 'en'): Promise<string[]> {
  window.history.replaceState(null, '', path)
  const urls: string[] = []
  restore()
  restore = stubSleep(urls, stub)
  const { client, tree } = withQuery(<Sleep />)
  act(() => { root?.render(<I18nProvider lng={lng}>{tree}</I18nProvider>) })
  await flush(client, () => container!.innerHTML)
  return urls
}

const cardFor = (label: string): HTMLElement | undefined => [...container!.querySelectorAll<HTMLElement>('section.card')]
  .find((card) => card.querySelector(':scope > .label')?.textContent === label)
const text = (): string => container!.textContent ?? ''
const standout = (): string | undefined => [...container!.querySelectorAll('.workout-hero-line')]
  .map((line) => line.textContent ?? '').find((line) => line.startsWith('longest') || line.startsWith('je langste'))
const month = (patch: Partial<SleepPeriodData>): SleepPeriodData => ({ ...SLEEP_PERIOD_MONTH, ...patch })

// One night, for the schedule chart's cases: the list row's bed and wake are what it draws.
const NIGHT_DATE = '2026-08-15'
const NIGHT_MIDNIGHT = Date.parse(`${NIGHT_DATE}T00:00:00Z`)
function oneNight(bedtimeMinutes: number, waketimeMinutes: number): SleepListRow[] {
  return [{
    localDate: NIGHT_DATE, sourceId: 'watch', asleepMinutes: 420, bedtimeMinutes, waketimeMinutes,
    standing: 'within', judged: null, good: false,
  }]
}
/** /sleep/nights' own night for NIGHT_DATE, carrying `naps`. */
function nightsWithNaps(naps: number[]): unknown[] {
  return [{
    localDate: NIGHT_DATE, sourceId: 'watch', sessionIds: ['s1'],
    startMs: NIGHT_MIDNIGHT - 40 * 60_000, endMs: NIGHT_MIDNIGHT + 425 * 60_000,
    startOffsetMinutes: 0, endOffsetMinutes: 0, naps, excludedSessions: [], segments: [],
  }]
}
const scheduleHost = () => container!.querySelector<HTMLDivElement>('div[role="img"][aria-label="Sleep schedule"]')

describe('the Sleep page: header and requests', () => {
  it('names the period and the source in the header line', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(container!.querySelector('h1')?.textContent).toBe('Sleep')
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Aug 1 – 31, 2026 · All sources')
    // The export downloads the period's summed sleep rollups.
    const exported = new URLSearchParams(container!.querySelector('a[href*="/export?"]')!.getAttribute('href')!.split('?')[1])
    expect(exported.getAll('metric')).toContain('sleep_asleep_minutes')
    expect([exported.get('agg'), exported.get('from'), exported.get('to')]).toEqual(['sum', '2026-08-01', '2026-08-31'])
  })

  it('names a picked source by its name in the header line, and asks for it', async () => {
    const urls = await renderAt(`${MONTH_URL}&source=watch`, { period: SLEEP_PERIOD_MONTH })
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Aug 1 – 31, 2026 · My watch')
    expect(urls.some((url) => url.includes('/sleep/period') && url.includes('source=watch'))).toBe(true)
  })

  it('resolves an unknown source to all sources before asking, for the period and its nights', async () => {
    const urls = await renderAt(`${MONTH_URL}&source=phantom-device`, { period: SLEEP_PERIOD_MONTH })
    const asked = urls.filter((url) => url.includes('/sleep/period') || url.includes('/sleep/nights'))
    expect(asked.length).toBeGreaterThan(1)
    for (const url of asked) expect(url).not.toContain('source=')
  })

  // The page stays mounted here once the URL moves (no router swaps it for the night page), so it
  // goes on to read the URL's defaults; what it must never do is ask for a period on that day.
  it('opens the night page for the Day tab, keeping the source, and asks for no period', async () => {
    const urls = await renderAt('/sleep?range=day&on=2026-08-15&source=watch', { period: SLEEP_PERIOD_MONTH })
    expect(window.location.pathname).toBe(nightPath('2026-08-15'))
    expect(new URLSearchParams(window.location.search).get('source')).toBe('watch')
    expect(urls.filter((url) => url.includes('/sleep/period') && url.includes('anchor=2026-08-15'))).toEqual([])
  })

  it('makes one period read, asks /sleep/nights on a month for the naps, and nothing from /series or /insights', async () => {
    const urls = await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(urls.filter((url) => url.includes('/sleep/period'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('/sleep/nights')).length).toBeGreaterThan(0)
    expect(urls.filter((url) => url.includes('/series') || url.includes('/insights'))).toEqual([])
  })

  // Nor last year's nights with the comparison on: a weekly strip draws no overlay.
  it.each([['3months', '2025-06-01'], ['year', '2025-06-01']])('asks no /sleep/nights and no /series on %s', async (range, on) => {
    const urls = await renderAt(`/sleep?range=${range}&on=${on}&compare=year`, { period: SLEEP_PERIOD_YEAR })
    expect(urls.filter((url) => url.includes('/series'))).toEqual([])
    expect(urls.filter((url) => url.includes('/sleep/period'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('/sleep/nights'))).toEqual([])
    expect(cardFor('Sleep schedule')).toBeDefined()
  })

  it('keeps the header over an error, and over an empty period says there are no nights', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH, status: 400 })
    expect(container!.querySelector('h1')?.textContent).toBe('Sleep')
    expect(container!.querySelector('.controls')).not.toBeNull()
    expect(cardFor('Time asleep')).toBeUndefined()
    // The error's own way back, not a loading line standing in for it.
    expect(container!.querySelector('.empty .button')?.textContent).toBe('Try again')
    act(() => { root?.unmount() })
    root = createRoot(container!)
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_EMPTY })
    expect(container!.querySelector('h1')?.textContent).toBe('Sleep')
    expect(container!.querySelector('.empty')?.textContent).toContain('No nights in this period')
    expect(container!.querySelectorAll('section.card')).toHaveLength(1)
  })

  it('carries no percentage change, no insight card and no percentage note', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(container!.querySelector('.delta')).toBeNull()
    expect(container!.querySelector('.insight-summary')).toBeNull()
    expect(container!.querySelector('.control-row-note')).toBeNull()
    expect(text()).not.toMatch(/[+\-−]\d+(?:[.,]\d+)?\s?%/)
  })
})

describe('the Sleep page: sections', () => {
  it('draws every section from the month fixture', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    for (const label of ['Time asleep', 'The nights', 'Sleep schedule', 'Nights', 'Sleep balance', 'The mornings', 'More about the sleep']) {
      expect(cardFor(label), label).toBeDefined()
    }
    // The four figures, in a card of their own with no label.
    expect([...container!.querySelectorAll('.detail-minis .figure-row-label')].map((l) => l.textContent))
      .toEqual(['Efficiency', 'Deep sleep', 'REM', 'Bedtime'])
    expect(cardFor('Sleep schedule')!.dataset.span).toBe('6')
    expect(cardFor('Nights')!.dataset.span).toBe('6')
    expect(cardFor('Sleep balance')!.dataset.span).toBe('6')
    expect(cardFor('The mornings')!.dataset.span).toBe('6')
  })

  it('leads with time asleep, its verdict with the window, the day counts and what stood out', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const hero = cardFor('Time asleep')!
    expect(hero.querySelector('.detail-hero-value')?.textContent).toBe('6h 59m')
    expect(hero.querySelector('.detail-verdict')?.textContent).toContain('for a month, last 12 months')
    expect(standout()).toBe('longest: 7h 27m on Aug 23 ✦ · -0h 01m against July')
    expect(hero.querySelector('.dash-caption')?.textContent).toBe('each night of this period')
    expect(sparklines.get('Time asleep')!.values).toHaveLength(31)
  })

  it('adds the year-earlier clause to the stood-out line with the comparison on, and only then', async () => {
    await renderAt(`${MONTH_URL}&compare=year`, { period: SLEEP_PERIOD_MONTH })
    expect(standout()).toBe('longest: 7h 27m on Aug 23 ✦ · -0h 01m against July · -0h 01m against last year')
  })

  it('overlays last year\'s nights on the hero\'s strip with the comparison on, aligned by date', async () => {
    const urls = await renderAt(`${MONTH_URL}&compare=year`, {
      period: SLEEP_PERIOD_MONTH,
      series: () => ({ sleep_asleep_minutes: { points: [seriesPoint('sleep_asleep_minutes', '2025-08-05', 400)], reduction: null } }),
    })
    // One /series read, for time asleep alone, only while the comparison is on.
    expect(urls.filter((url) => url.includes('/series'))).toHaveLength(1)
    const lastYear = sparklines.get('Time asleep')!.lastYear!
    expect(lastYear).toHaveLength(31)
    expect(lastYear[4]).toBe(400)
    expect(lastYear.filter((value) => value !== null)).toEqual([400])
  })

  it.each<[string, Partial<SleepPeriodData>]>([
    ['The nights', { stages: { deep: null, light: null, rem: null, awake: null, shares: null } }],
    ['More about the sleep', { more: [] }],
  ])('leaves out %s when its data is absent', async (label, patch) => {
    await renderAt(MONTH_URL, { period: month(patch) })
    expect(cardFor(label)).toBeUndefined()
    expect(cardFor('Time asleep')).toBeDefined()
  })

  it('leaves out the four figures when none has a value', async () => {
    await renderAt(MONTH_URL, { period: month({ figures: SLEEP_PERIOD_MONTH.figures.map((f) => ({ ...f, value: null })) }) })
    expect(container!.querySelector('.detail-minis')).toBeNull()
  })

  it.each<[string, string, Partial<SleepPeriodData>]>([
    ['Sleep schedule', 'Nights', { schedule: { bedtime: null, waketime: null, variability: null, sides: { weekday: null, weekend: null } } }],
    ['Nights', 'Sleep schedule', { nights: [] }],
    ['Sleep balance', 'The mornings', { balance: null }],
    ['The mornings', 'Sleep balance', { mornings: [] }],
  ])('leaves out %s when its data is absent, and %s takes the whole row', async (gone, partner, patch) => {
    await renderAt(MONTH_URL, { period: month(patch) })
    expect(cardFor(gone)).toBeUndefined()
    expect(cardFor(partner)!.dataset.span).toBe('12')
  })

  it('leaves out the balance when no night in it has a reading', async () => {
    const balance = { ...SLEEP_PERIOD_MONTH.balance, values: SLEEP_PERIOD_MONTH.balance.values.map(() => null) }
    await renderAt(MONTH_URL, { period: month({ balance }) })
    expect(cardFor('Sleep balance')).toBeUndefined()
  })

  it('widens the schedule with the list when the list is expanded', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(cardFor('Nights')!.querySelectorAll('.night-row')).toHaveLength(7)
    act(() => { cardFor('Nights')!.querySelector<HTMLButtonElement>('.period-list-toggle')!.click() })
    expect(cardFor('Nights')!.querySelectorAll('.night-row')).toHaveLength(SLEEP_PERIOD_MONTH.nights.length)
    expect(cardFor('Nights')!.dataset.span).toBe('12')
    expect(cardFor('Sleep schedule')!.dataset.span).toBe('12')
  })

  it('keeps the expanded list of a month ungrouped', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    act(() => { cardFor('Nights')!.querySelector<HTMLButtonElement>('.period-list-toggle')!.click() })
    expect(cardFor('Nights')!.querySelector('.period-list-heading')).toBeNull()
  })

  it('draws weekly points on a year, and groups the expanded list by month', async () => {
    await renderAt(YEAR_URL, { period: SLEEP_PERIOD_YEAR })
    expect(sparklines.get('Time asleep')!.values).toHaveLength(SLEEP_PERIOD_YEAR.hero.weekly!.length)
    expect(cardFor('Time asleep')!.querySelector('.dash-caption')?.textContent).toBe('each week of this period, as its average')
    // No schedule chart on a year: its bedtime and wake time rows over their weeks instead.
    expect(scheduleHost()).toBeNull()
    expect([...cardFor('Sleep schedule')!.querySelectorAll('.figure-row-label')].map((l) => l.textContent))
      .toEqual(['Bedtime', 'Wake time', 'Bedtime variability'])
    expect(sparklines.get('Bedtime')!.values).toHaveLength(SLEEP_PERIOD_YEAR.schedule.bedtime!.weekly!.length)
    expect(cardFor('Nights')!.querySelector('.period-list-heading')).toBeNull()
    act(() => { cardFor('Nights')!.querySelector<HTMLButtonElement>('.period-list-toggle')!.click() })
    const headings = [...cardFor('Nights')!.querySelectorAll('.period-list-heading')].map((h) => h.textContent)
    expect(headings[0]).toBe('December 2025')
    expect(headings).toHaveLength(12)
  })

  it('writes the hour as "u" in Dutch, and the verdict in the catalogue\'s words', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    expect(cardFor('Tijd in slaap')!.querySelector('.detail-hero-value')?.textContent).toBe('6u 59m')
    expect(cardFor('Tijd in slaap')!.querySelector('.detail-verdict')?.textContent).toContain('gebruikelijk')
    expect(text()).not.toMatch(/\dh\s\d\dm/)
  })
})

describe('the Sleep page: the hero\'s point panel', () => {
  it('opens a night\'s panel with its figures and its page, and hands the annotate over to the AnnotatePanel', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    act(() => { sparklines.get('Time asleep')!.onPointClick!('2026-08-31') })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelector('.point-panel-title')?.textContent).toBe('Aug 31, 2026')
    expect([...panel.querySelectorAll('.point-panel-row')].map((row) => row.textContent))
      .toEqual(['Time asleep7h 18m', 'Bedtime22:44', 'Wake time06:32'])
    expect(panel.querySelector('a')?.getAttribute('href')).toBe(nightPath('2026-08-31'))
    expect(panel.querySelector('a')?.textContent).toBe('View night')
    act(() => { panel.querySelector<HTMLButtonElement>('button')!.click() })
    expect(container!.querySelector('.point-panel')).toBeNull()
    expect(document.querySelector('.annotate-panel')).not.toBeNull()
  })

  it('opens a week\'s panel on a year with that week\'s time asleep alone, and no way onward', async () => {
    await renderAt(YEAR_URL, { period: SLEEP_PERIOD_YEAR })
    const week = SLEEP_PERIOD_YEAR.hero.weekly![3]!
    act(() => { sparklines.get('Time asleep')!.onPointClick!(week.from) })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelectorAll('.point-panel-row')).toHaveLength(1)
    expect(panel.querySelector('.point-panel-row dt')?.textContent).toBe('Time asleep')
    expect(panel.querySelector('a')).toBeNull()
    expect(panel.querySelector('button')).toBeNull()
  })
})

describe('the Sleep page: the nights, the stages, the mornings', () => {
  it('lists each night with its time asleep, a verdict dot, bed to wake and the good-night mark, linking to it', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const first = cardFor('Nights')!.querySelector('a')!
    expect(first.getAttribute('href')).toBe(nightPath('2026-08-31'))
    expect(first.querySelector('.night-row-date')?.textContent).toBe('Monday, August 31')
    expect(first.querySelector('.night-row-duration')?.textContent).toBe('7h 18m')
    expect(first.querySelector('.night-row-dot')?.className).toBe('night-row-dot better')
    expect(first.querySelector('.night-row-good')?.textContent).toBe('✦')
    expect(first.querySelector('.night-row-clock')?.textContent).toBe('22:44 to 06:32')
    // The dot's standing in words, for a screen reader.
    expect(first.querySelector('.sr-only')?.textContent).toBe('above your usual')
    const second = cardFor('Nights')!.querySelectorAll('a')[1]!
    expect(second.querySelector('.night-row-good')).toBeNull()
  })

  // The source the reader named goes with them, the same way the hero's panel and the Day tab take it.
  it('keeps the named source on each night\'s link, as the panel does', async () => {
    await renderAt(`${MONTH_URL}&source=watch`, { period: SLEEP_PERIOD_MONTH })
    const expected = `${nightPath('2026-08-31')}?source=watch`
    expect(cardFor('Nights')!.querySelector('a')!.getAttribute('href')).toBe(expected)
    act(() => { sparklines.get('Time asleep')!.onPointClick!('2026-08-31') })
    expect(container!.querySelector('.point-panel a')?.getAttribute('href')).toBe(expected)
  })

  it('leaves out bed to wake on a night missing either', async () => {
    const [night] = oneNight(-40, 425)
    await renderAt(MONTH_URL, { period: month({ nights: [{ ...night!, bedtimeMinutes: null }] }) })
    expect(cardFor('Nights')!.querySelector('.night-row-clock')).toBeNull()
    expect(cardFor('Nights')!.querySelector('.night-row-dot')?.className).toBe('night-row-dot')
  })

  it('draws each stage in its own colour', async () => {
    // CHART_VARS[0] is the deep stage's variable (tokens.ts lists the stages first).
    document.documentElement.style.setProperty(CHART_VARS[0]!, '#112233')
    try {
      await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
      const host = cardFor('The nights')!.querySelector<HTMLDivElement>('div[role="img"]')!
      const option = echarts.getInstanceByDom(host)?.getOption() as { series?: { name?: string, itemStyle?: { color?: string } }[] }
      expect(option.series![0]!.name).toBe('Deep')
      expect(option.series![0]!.itemStyle!.color).toBe('#112233')
    } finally {
      document.documentElement.style.setProperty(CHART_VARS[0]!, '#000000')
    }
  })

  it('gives each stage\'s average and share in the legend, through the shared stage names', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    const legend = [...cardFor('De nachten')!.querySelectorAll('.detail-legend li')].map((li) => li.textContent)
    expect(legend).toEqual(['Diep 1u 10m · 16 %', 'Licht 4u 10m · 58 %', 'REM 1u 25m · 20 %', 'Wakker 0u 28m · 6 %'])
  })

  it('says the weekend against the weekdays under the schedule', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(cardFor('Sleep schedule')!.textContent).toContain('At the weekend 6 min later to bed and 7 min later up')
  })

  // Earlier, the same, and across midnight, in the stored convention (signed minutes from the wake
  // day's midnight): 23:50 on weekdays (-10) against 00:10 at the weekend (10) is twenty minutes later.
  it('words an earlier and an unchanged side, and measures across midnight the short way', async () => {
    const schedule = {
      ...SLEEP_PERIOD_MONTH.schedule,
      sides: { weekday: { bedtimeMinutes: -10, waketimeMinutes: 430, nights: 5 }, weekend: { bedtimeMinutes: 10, waketimeMinutes: 430, nights: 2 } },
    }
    await renderAt(MONTH_URL, { period: month({ schedule }) })
    expect(cardFor('Sleep schedule')!.textContent).toContain('At the weekend 20 min later to bed and at the same time up')
    act(() => { root?.unmount() })
    root = createRoot(container!)
    const earlier = { ...schedule, sides: { ...schedule.sides, weekend: { bedtimeMinutes: -40, waketimeMinutes: 420, nights: 2 } } }
    await renderAt(MONTH_URL, { period: month({ schedule: earlier }) }, 'nl')
    expect(cardFor('Slaapschema')!.textContent).toContain('In het weekend 30 min eerder naar bed en 10 min eerder wakker')
  })

  it('leaves the weekend sentence out when either side is missing', async () => {
    const schedule = { ...SLEEP_PERIOD_MONTH.schedule, sides: { ...SLEEP_PERIOD_MONTH.schedule.sides, weekend: null } }
    await renderAt(MONTH_URL, { period: month({ schedule }) })
    expect(cardFor('Sleep schedule')!.textContent).not.toContain('At the weekend')
  })

  it('reads skin temperature as a deviation from its usual, and as its reading with no usual', async () => {
    const skin: PeriodFigure = {
      ...SLEEP_PERIOD_MONTH.mornings[1]!, metric: 'sleep_temperature', unit: 'celsius', precision: 1, direction: 'neutral',
      value: 33.6, usual: { ...SLEEP_PERIOD_MONTH.mornings[1]!.usual!, center: 33.3, low: 33, high: 33.6 }, standing: 'within',
    }
    await renderAt(MONTH_URL, { period: month({ mornings: [skin] }) })
    const row = () => [...cardFor('The mornings')!.querySelectorAll('.figure-row')]
      .find((r) => r.querySelector('.figure-row-label')?.textContent === 'Skin temperature')!
    expect(row().querySelector('.figure-row-value')?.textContent).toBe('+0.3 °C')
    expect(row().querySelector('.figure-row-verdict')?.textContent).toContain('±0.3 °C')
    // No usual, a thin one, or a reason not to judge: the reading itself, never "— °C".
    const unjudged: PeriodFigure[] = [
      { ...skin, usual: null, reason: 'thin-usual', standing: null },
      { ...skin, usual: { ...skin.usual!, thin: true }, standing: null },
      { ...skin, reason: 'too-few-days', standing: null },
    ]
    for (const figure of unjudged) {
      act(() => { root?.unmount() })
      root = createRoot(container!)
      await renderAt(MONTH_URL, { period: month({ mornings: [figure] }) })
      expect(row().querySelector('.figure-row-value')?.textContent).toBe('33.6 °C')
    }
  })
})

describe('the Sleep page: the schedule chart', () => {
  // A night running past the default window's far noon: 20:00 to 22:00 the next day is 26 hours,
  // which the wide window holds. Asserted against the accessible table, never the canvas.
  it('draws a night running past the default window rather than suppressing it as no data', async () => {
    await renderAt(MONTH_URL, { period: month({ nights: oneNight(-4 * 60, 22 * 60) }) })
    const table = [...container!.querySelectorAll('table.sr-only')].find((t) => t.textContent?.includes('22:00'))
    expect(table).toBeDefined()
    expect(table!.textContent).not.toContain('no reading')
  })

  it('fills the naps column from /sleep/nights, rather than claiming none', async () => {
    await renderAt(MONTH_URL, { period: month({ nights: oneNight(-40, 425) }), nights: nightsWithNaps([NIGHT_MIDNIGHT + 870 * 60_000]) })
    const table = [...container!.querySelectorAll('table.sr-only')].find((t) => t.textContent?.includes('Naps'))
    expect(table).toBeDefined()
    expect(table!.textContent).toContain('14:30')
  })

  // The plotted number, off the chart's own option: formatClock is mod 1440, so the table cannot
  // tell a nap drawn at 870 from one at 2310. Bed -40 and wake 425 place at 1400 and 1865, so the
  // 14:30 nap after that wake belongs at 870 + 1440 in the same frame.
  it('plots an afternoon nap in its own night\'s frame, not a day to the left of it', async () => {
    await renderAt(MONTH_URL, { period: month({ nights: oneNight(-40, 425) }), nights: nightsWithNaps([NIGHT_MIDNIGHT + 870 * 60_000]) })
    const option = echarts.getInstanceByDom(scheduleHost()!)?.getOption() as { series?: { type?: string, data?: unknown }[] } | undefined
    const scatter = (option?.series ?? []).find((series) => series.type === 'scatter')
    expect(scatter!.data).toEqual([[0, 2310]])
  })

  it('draws the schedule on an axis of at most a day, with whole-hour ticks and no repeated label', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const option = echarts.getInstanceByDom(scheduleHost()!)?.getOption() as
      { yAxis?: { min?: number, max?: number, interval?: number, axisLabel?: { showMaxLabel?: boolean } }[] } | undefined
    const yAxis = option!.yAxis![0]!
    const { min, max, interval } = yAxis as { min: number, max: number, interval: number }
    expect(max - min).toBeGreaterThan(0)
    expect(max - min).toBeLessThanOrEqual(1440)
    expect(min >= WIDE_WINDOW.min && max <= WIDE_WINDOW.max).toBe(true)
    expect(interval).toBe(axisTickInterval({ min, max }))
    expect((max - min) % interval).toBe(0)
    const printed: number[] = []
    for (let v = min; v <= max; v += interval) {
      if (v === max && yAxis.axisLabel?.showMaxLabel === false) continue
      printed.push(((v % 1440) + 1440) % 1440)
    }
    expect(new Set(printed).size).toBe(printed.length)
  })

  it('shades the usual bed and wake bands around the nights they describe', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const option = echarts.getInstanceByDom(scheduleHost()!)?.getOption() as
      { series?: { markArea?: { data?: [{ yAxis: number }, { yAxis: number }][] } }[] }
    const bands = option.series!.flatMap((series) => series.markArea?.data ?? [])
    expect(bands).toHaveLength(2)
    const bed = bands[0]![0]
    const wake = bands[1]![0]
    // In the frame the bars are drawn in: bed in the evening, wake the next morning, a night after it.
    expect(bed!.yAxis).toBeGreaterThan(1200)
    expect(bed!.yAxis).toBeLessThan(1500)
    expect(wake!.yAxis).toBeGreaterThan(1800)
    expect(wake!.yAxis).toBeLessThan(2000)
  })

  // What each night's placed bed and wake are, off the chart's own series data: the table's clock
  // times are mod 1440 and cannot tell a 7-hour bar from a 31-hour one.
  const placed = () => ((echarts.getInstanceByDom(scheduleHost()!)?.getOption() as
    { series?: { type?: string, data?: unknown }[] }).series ?? []).find((series) => series.type === 'custom')!.data

  it('draws a bedtime before midnight, stored as -56, at 23:04 the evening before', async () => {
    await renderAt(MONTH_URL, { period: month({ nights: oneNight(-56, 400) }) })
    expect(placed()).toEqual([[0, 1384, 1840]])
    const table = [...container!.querySelectorAll('table.sr-only')].find((t) => t.textContent?.includes('Naps'))!
    expect(table.textContent).toContain('23:04')
  })

  // A day sleeper's main sleep ends on its own date, so its bed is 780 (13:00) and its wake 1200.
  it('draws a day sleeper\'s 13:00 to 20:00 as seven hours, not a day and seven hours', async () => {
    await renderAt(MONTH_URL, { period: month({ nights: oneNight(780, 1200) }) })
    expect(placed()).toEqual([[0, 780, 1200]])
  })

  it('names the band in the caption only when one is drawn', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(cardFor('Sleep schedule')!.querySelector('.dash-caption')?.textContent)
      .toBe('each bar: one night, bedtime to wake time · band = your usual times')
    act(() => { root?.unmount() })
    root = createRoot(container!)
    const unbanded = (figure: PeriodFigure | null) => figure && { ...figure, daily: figure.daily.map((point) => ({ ...point, band: null })) }
    const schedule = { ...SLEEP_PERIOD_MONTH.schedule, bedtime: unbanded(SLEEP_PERIOD_MONTH.schedule.bedtime), waketime: unbanded(SLEEP_PERIOD_MONTH.schedule.waketime) }
    await renderAt(MONTH_URL, { period: month({ schedule }) })
    expect(cardFor('Sleep schedule')!.querySelector('.dash-caption')?.textContent).toBe('each bar: one night, bedtime to wake time')
  })
})
