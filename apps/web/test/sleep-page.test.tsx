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

// The no-break space formatFigureValue joins a value's parts with.
const NB = '\u00a0'
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
// The hero's own label, which names the average ("Time asleep, average per night"); the panel and
// the night page keep the figure's plain name.
const HERO = 'Time asleep, average per night'
// The hero's quiet lines under the verdict: the counts, then one line for each thing that stood out.
const heroLines = (): string[] => [...cardFor(HERO)!.querySelectorAll('.workout-hero-line')].map((line) => line.textContent ?? '')
const heroBold = (): string[] => [...cardFor(HERO)!.querySelectorAll('.workout-hero-line strong')].map((line) => line.textContent ?? '')
const month = (patch: Partial<SleepPeriodData>): SleepPeriodData => ({ ...SLEEP_PERIOD_MONTH, ...patch })

// One night, for the schedule chart's cases: the list row's bed and wake are what it draws.
const NIGHT_DATE = '2026-08-15'
const NIGHT_MIDNIGHT = Date.parse(`${NIGHT_DATE}T00:00:00Z`)
function oneNight(bedtimeMinutes: number, waketimeMinutes: number): SleepListRow[] {
  return [{
    localDate: NIGHT_DATE, sourceId: 'watch', asleepMinutes: 420, bedtimeMinutes, waketimeMinutes,
    // 15 August 2026 is a Saturday morning.
    standing: 'within', judged: null, good: false, weekend: true,
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

  it('spaces the dash of a Dutch range inside one month, which the locale closes up', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    expect(container!.querySelector('.dash-date')?.textContent).toBe('1 – 31 aug 2026 · Alle bronnen')
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

  it.each<[string, SleepStub]>([
    ['a loaded period', { period: SLEEP_PERIOD_MONTH }],
    ['a failed read', { period: SLEEP_PERIOD_MONTH, status: 400 }],
    ['an empty period', { period: SLEEP_PERIOD_EMPTY }],
  ])('draws %s inside a detail page, so its cards take the card-label gap', async (_, stub) => {
    await renderAt(MONTH_URL, stub)
    expect(container!.querySelector(':scope > .detail-page > h1, :scope > .detail-page h1')?.textContent).toBe('Sleep')
    expect(container!.querySelector(':scope > .detail-page > .grid')).not.toBeNull()
  })

  it('keeps the header over an error, and over an empty period says there are no nights', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH, status: 400 })
    expect(container!.querySelector('h1')?.textContent).toBe('Sleep')
    expect(container!.querySelector('.controls')).not.toBeNull()
    expect(cardFor(HERO)).toBeUndefined()
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
    for (const label of [HERO, 'The nights', 'Sleep schedule', 'Nights', 'Sleep balance', 'The mornings', 'More about the sleep']) {
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

  it('leads with time asleep per night, its verdict with the window, the day counts and what stood out', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const hero = cardFor(HERO)!
    expect(hero.querySelector('.detail-hero-value')?.textContent).toBe('6h 59m')
    // The window follows the range after a plain space: the one place the page names it.
    expect(hero.querySelector('.detail-verdict')?.textContent).toBe('within your usual 6h 59m – 7h 00m for a month, last 12 months')
    expect(heroLines()).toEqual(['16 of 28 nights usual · 6 longer · 6 shorter', 'longest: 7h 27m on Sun, Aug 23 ✦', '-0h 01m against July'])
    expect(heroBold()).toEqual(['7h 27m', '-0h 01m'])
    expect([...hero.querySelectorAll('.period-hero-captions .dash-caption')].map((caption) => caption.textContent))
      .toEqual(['every night this month', 'tap a night for the figures'])
    expect(sparklines.get(HERO)!.values).toHaveLength(31)
  })

  it('names the window in the hero alone: no other verdict on the page repeats it', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(text().split('for a month, last 12 months')).toHaveLength(2)
  })

  it('adds the year-earlier change as a line of its own with the comparison on, and only then', async () => {
    await renderAt(`${MONTH_URL}&compare=year`, { period: SLEEP_PERIOD_MONTH })
    expect(heroLines()).toEqual([
      '16 of 28 nights usual · 6 longer · 6 shorter', 'longest: 7h 27m on Sun, Aug 23 ✦', '-0h 01m against July', '-0h 01m against last year',
    ])
  })

  it('says under each card of strips what a line and its band are', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(container!.querySelector('.detail-minis')!.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every night this month · band = your usual range')
    expect(cardFor('The mornings')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every morning this month · band = your usual range')
  })

  it('counts the mornings in mornings, and More about the sleep without a noun', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const notes = (label: string) => [...cardFor(label)!.querySelectorAll('.figure-row-note')].map((note) => note.textContent ?? '')
    expect(notes('The mornings').length).toBeGreaterThan(0)
    for (const note of notes('The mornings')) expect(note).toMatch(/^\d+ of \d+ mornings? usual/)
    // Every row but the naps, whose line is their own (the next test).
    const more = notes('More about the sleep').filter((note) => !note.includes('naps'))
    expect(more.length).toBeGreaterThan(0)
    for (const note of more) expect(note).toMatch(/^\d+ of \d+ usual/)
  })

  // The fixture's August holds four naps and 100 minutes of them.
  it("prints the naps as one row: the count, its usual a month's worth, and the naps and minutes together", async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const naps = () => [...cardFor('More about the sleep')!.querySelectorAll('.figure-row')].filter((row) => row.querySelector('.label')?.textContent === 'Naps')
    expect(naps()).toHaveLength(1)
    expect(naps()[0]!.querySelector('.figure-row-verdict')!.textContent).toBe('within your usual 3 – 4 per month')
    expect(naps()[0]!.querySelector('.figure-row-note')!.textContent).toBe(`4 naps, 1h${NB}40m together`)
    expect(naps()[0]!.querySelector('.figure-row-value')!.textContent).toBe('4')
    act(() => { root?.unmount() }); root = createRoot(container!)
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    const dutjes = [...cardFor('Meer over de slaap')!.querySelectorAll('.figure-row')].filter((row) => row.querySelector('.label')?.textContent === 'Dutjes')
    expect(dutjes).toHaveLength(1)
    expect(dutjes[0]!.querySelector('.figure-row-verdict')!.textContent).toBe('binnen je gebruikelijke bereik 3 – 4 per maand')
    expect(dutjes[0]!.querySelector('.figure-row-note')!.textContent).toBe(`4 dutjes, samen 1u${NB}40m`)
  })

  it('says no naps rather than none together, and keeps the minutes row where no count came', async () => {
    const more = SLEEP_PERIOD_MONTH.more.map((figure) => (figure.metric === 'sleep_nap_count' ? { ...figure, total: 0 } : figure))
    await renderAt(MONTH_URL, { period: month({ more }) })
    const note = () => [...cardFor('More about the sleep')!.querySelectorAll('.figure-row')]
      .filter((row) => row.querySelector('.label')?.textContent === 'Naps').map((row) => row.querySelector('.figure-row-note')?.textContent)
    expect(note()).toEqual(['no naps'])
    act(() => { root?.unmount() }); root = createRoot(container!)
    await renderAt(MONTH_URL, { period: month({ more: SLEEP_PERIOD_MONTH.more.filter((figure) => figure.metric !== 'sleep_nap_count') }) })
    expect(note()).toEqual(['24 of 28 usual · 4 longer'])
  })

  it('overlays last year\'s nights on the hero\'s strip with the comparison on, aligned by date', async () => {
    const urls = await renderAt(`${MONTH_URL}&compare=year`, {
      period: SLEEP_PERIOD_MONTH,
      series: () => ({ sleep_asleep_minutes: { points: [seriesPoint('sleep_asleep_minutes', '2025-08-05', 400)], reduction: null } }),
    })
    // One /series read, for time asleep alone, only while the comparison is on.
    expect(urls.filter((url) => url.includes('/series'))).toHaveLength(1)
    const lastYear = sparklines.get(HERO)!.lastYear!
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
    expect(cardFor(HERO)).toBeDefined()
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

  it.each<[string, Partial<SleepPeriodData>, string]>([
    ['two across in a half card', {}, '2'],
    ['three across alone', { balance: null }, '3'],
  ])('sets the mornings %s', async (_, patch, columns) => {
    await renderAt(MONTH_URL, { period: month(patch) })
    expect(cardFor('The mornings')!.querySelector<HTMLElement>('.detail-side-rows')!.dataset.columns).toBe(columns)
  })

  // Bedtime and wake time: two rows, two across whether the card is half or whole.
  it.each<[string, Partial<SleepPeriodData>]>([
    ['in a half card', {}],
    ['alone', { nights: [] }],
  ])('sets the two schedule rows of a year two across %s', async (_, patch) => {
    await renderAt(YEAR_URL, { period: { ...SLEEP_PERIOD_YEAR, ...patch } })
    const rows = cardFor('Sleep schedule')!.querySelector<HTMLElement>('.detail-rows')!
    expect(rows.querySelectorAll('.figure-row')).toHaveLength(2)
    expect(rows.dataset.columns).toBe('2')
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

  it('draws weekly points on a year, and groups the list by month', async () => {
    await renderAt(YEAR_URL, { period: SLEEP_PERIOD_YEAR })
    expect(sparklines.get(HERO)!.values).toHaveLength(SLEEP_PERIOD_YEAR.hero.weekly!.length)
    expect([...cardFor(HERO)!.querySelectorAll('.period-hero-captions .dash-caption')].map((caption) => caption.textContent))
      .toEqual(['every week, as its average', 'tap a week for the figures'])
    expect(container!.querySelector('.detail-minis')!.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every week, the average of its nights · band = your usual range')
    expect(cardFor('The mornings')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every week, the average of its mornings · band = your usual range')
    expect(cardFor('The nights')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('stages per night, averaged per week · average per night in the legend')
    // No schedule chart on a year: its bedtime and wake time rows over their weeks, under the
    // variability sentence, which replaces its row on every range.
    expect(scheduleHost()).toBeNull()
    expect([...cardFor('Sleep schedule')!.querySelectorAll('.figure-row-label')].map((l) => l.textContent))
      .toEqual(['Bedtime', 'Wake time'])
    expect(cardFor('Sleep schedule')!.querySelector('.schedule-sentences p')?.textContent).toMatch(/^Bedtime varied ±\d+\smin this year/)
    expect(sparklines.get('Bedtime')!.values).toHaveLength(SLEEP_PERIOD_YEAR.schedule.bedtime!.weekly!.length)
    // Collapsed, the seven newest nights are December's, under its header and the server's summary.
    const headings = () => [...cardFor('Nights')!.querySelectorAll('.period-list-heading')]
      .map((h) => [h.querySelector('.period-list-name')?.textContent, h.querySelector('.period-list-aside')?.textContent ?? null])
    expect(headings()).toEqual([['December', `28 nights · avg. 7h${NB}00m`]])
    act(() => { cardFor('Nights')!.querySelector<HTMLButtonElement>('.period-list-toggle')!.click() })
    expect(headings()[0]).toEqual(['December', `28 nights · avg. 7h${NB}00m`])
    expect(headings()).toHaveLength(12)
    expect(headings()[11]).toEqual(['January', `29 nights · avg. 7h${NB}01m`])
  })

  it('heads each month in Dutch, and with no average says only how many nights', async () => {
    await renderAt(YEAR_URL, { period: SLEEP_PERIOD_YEAR }, 'nl')
    const heading = () => cardFor('Nachten')!.querySelector('.period-list-heading')!
    expect(heading().querySelector('.period-list-name')?.textContent).toBe('december')
    expect(heading().querySelector('.period-list-aside')?.textContent).toBe(`28 nachten · gem. 7u${NB}00m`)
    act(() => { root?.unmount() }); root = createRoot(container!)
    await renderAt(YEAR_URL, { period: { ...SLEEP_PERIOD_YEAR, months: [{ month: '2025-12', nights: 1, asleepMinutes: null }] } }, 'nl')
    expect(heading().querySelector('.period-list-aside')?.textContent).toBe('1 nacht')
    act(() => { root?.unmount() }); root = createRoot(container!)
    await renderAt(YEAR_URL, { period: { ...SLEEP_PERIOD_YEAR, months: [] } }, 'nl')
    expect(heading().querySelector('.period-list-aside')).toBeNull()
  })

  it('writes the hour as "u" in Dutch, and the verdict in the catalogue\'s words', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    const hero = cardFor('Tijd in slaap, gemiddeld per nacht')!
    expect(hero.querySelector('.detail-hero-value')?.textContent).toBe('6u 59m')
    expect(hero.querySelector('.detail-verdict')?.textContent).toBe('binnen je gebruikelijke bereik 6u 59m – 7u 00m voor een maand, afgelopen 12 maanden')
    expect([...hero.querySelectorAll('.workout-hero-line')].map((line) => line.textContent))
      .toEqual(['16 van 28 nachten gebruikelijk · 6 langer · 6 korter', 'je langste: 7u 27m op zo 23 aug ✦', '-0u 01m tegenover juli'])
    expect([...hero.querySelectorAll('.period-hero-captions .dash-caption')].map((caption) => caption.textContent))
      .toEqual(['elke nacht deze maand', 'tik op een nacht voor de cijfers'])
    expect(cardFor('De nachten')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('fasen per nacht deze maand · gemiddeld per nacht in de legenda')
    expect(cardFor('Nachten')!.querySelector('.night-list-caption')?.textContent).toBe('de nieuwste eerst · de stip is de verdict van die nacht')
    expect(cardFor('Nachten')!.querySelector('.period-list-toggle')?.textContent).toBe(`Toon alle ${SLEEP_PERIOD_MONTH.nights.length} nachten`)
    expect(cardFor('Slaapbalans')!.querySelector('.night-week-against')?.textContent).toBe('ten opzichte van je gebruikelijke 6u 59m, over 28 nachten')
    expect(cardFor('De ochtenden')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('elk lijntje: elke ochtend deze maand · band = je gebruikelijke bereik')
    expect(text()).not.toMatch(/\dh\s\d\dm/)
    // The list's short weekday date, so an expanded column keeps a row on one line.
    expect(cardFor('Nachten')!.querySelector('.night-row-date')?.textContent).toBe('ma 31 aug')
  })
})

describe('the Sleep page: the hero\'s point panel', () => {
  it('opens a night\'s panel with its figures and its page, and hands the annotate over to the AnnotatePanel', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    act(() => { sparklines.get(HERO)!.onPointClick!('2026-08-31') })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelector('.point-panel-title')?.textContent).toBe('Monday, August 31')
    expect(panel.querySelector('.point-panel-subtitle')?.textContent).toBe('bedtime 22:44 · wake time 06:32')
    // The mockup's rows, each with that night's own verdict; REM is left to the night page.
    const cells = (row: Element) => [...row.children].map((cell) => cell.textContent)
    expect([...panel.querySelectorAll('.point-panel-row')].map(cells)).toEqual([
      ['Time asleep', `7h${NB}18m`, 'above your usual'],
      ['Efficiency', `93${NB}%`, 'within your usual'],
      ['Deep sleep', `1h${NB}15m`, 'above your usual'],
      ['Bedtime', '22:44', 'earlier than your usual'],
    ])
    expect([...panel.querySelectorAll('.point-panel-verdict')].map((v) => v.className))
      .toEqual(['point-panel-verdict better', 'point-panel-verdict', 'point-panel-verdict better', 'point-panel-verdict is-out'])
    expect(panel.querySelector('a')?.getAttribute('href')).toBe(nightPath('2026-08-31'))
    expect(panel.querySelector('a')?.textContent).toBe('View night')
    act(() => { panel.querySelector<HTMLButtonElement>('.point-panel-actions button')!.click() })
    expect(container!.querySelector('.point-panel')).toBeNull()
    expect(document.querySelector('.annotate-panel')).not.toBeNull()
  })

  it('opens a week\'s panel on a year with that week\'s time asleep alone, and no way onward', async () => {
    await renderAt(YEAR_URL, { period: SLEEP_PERIOD_YEAR })
    const week = SLEEP_PERIOD_YEAR.hero.weekly![3]!
    act(() => { sparklines.get(HERO)!.onPointClick!(week.from) })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelectorAll('.point-panel-row')).toHaveLength(1)
    expect(panel.querySelector('.point-panel-row dt')?.textContent).toBe('Time asleep')
    expect(panel.querySelector('a')).toBeNull()
    expect(panel.querySelector('.point-panel-actions')).toBeNull()
    act(() => { panel.querySelector<HTMLButtonElement>('.point-panel-close')!.click() })
    expect(container!.querySelector('.point-panel')).toBeNull()
  })

  it('titles and words a night\'s panel in Dutch', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    act(() => { sparklines.get('Tijd in slaap, gemiddeld per nacht')!.onPointClick!('2026-08-31') })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelector('.point-panel-title')?.textContent).toBe('maandag 31 augustus')
    expect(panel.querySelector('.point-panel-subtitle')?.textContent).toBe('naar bed 22:44 · wakker geworden 06:32')
    expect([...panel.querySelectorAll('.point-panel-verdict')].map((v) => v.textContent))
      .toEqual(['boven je gebruikelijke bereik', 'binnen je gebruikelijke bereik', 'boven je gebruikelijke bereik', 'eerder dan je gebruikelijke tijd'])
    expect(panel.querySelector('.point-panel-close')?.getAttribute('aria-label')).toBe('Sluiten')
  })
})

describe('the Sleep page: the nights, the stages, the mornings', () => {
  it('lists each night with its time asleep, a verdict dot, bed to wake and the good-night mark, linking to it', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(cardFor('Nights')!.querySelector('.night-list-caption')?.textContent).toBe('newest first · the dot is that night\'s verdict')
    const first = cardFor('Nights')!.querySelector('a')!
    expect(first.getAttribute('href')).toBe(nightPath('2026-08-31'))
    // The mockup's order: date, time asleep, dot, bed to wake, then the good-night mark.
    expect([...first.querySelector('.night-row-main')!.children].map((child) => child.className))
      .toEqual(['night-row-date', 'night-row-duration', 'night-row-dot better', 'sr-only', 'night-row-clock', 'night-row-good'])
    expect(first.querySelector('.night-row-date')?.textContent).toBe('Mon, Aug 31')
    expect(first.querySelector('.night-row-duration')?.textContent).toBe('7h 18m')
    expect(first.querySelector('.night-row-dot')?.className).toBe('night-row-dot better')
    expect(first.querySelector('.night-row-good')?.textContent).toBe('✦')
    expect(first.querySelector('.night-row-clock')?.textContent).toBe('22:44 – 06:32')
    // The dot's standing in words, for a screen reader.
    expect(first.querySelector('.sr-only')?.textContent).toBe('above your usual')
    const second = cardFor('Nights')!.querySelectorAll('a')[1]!
    expect(second.querySelector('.night-row-good')).toBeNull()
  })

  it('names the period\'s high as the longest, and offers all its nights by name', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const toggle = cardFor('Nights')!.querySelector<HTMLButtonElement>('.period-list-toggle')!
    expect(toggle.textContent).toBe(`Show all ${SLEEP_PERIOD_MONTH.nights.length} nights`)
    act(() => { toggle.click() })
    const rowOn = (date: string) => cardFor('Nights')!.querySelector(`a[href="${nightPath(date)}"]`)!
    // SLEEP_PERIOD_MONTH's high is the good night of Aug 23; Aug 31 is good but not the high.
    expect(SLEEP_PERIOD_MONTH.high?.localDate).toBe('2026-08-23')
    expect(rowOn('2026-08-23').querySelector('.night-row-good')?.textContent).toBe('✦ your longest')
    expect(rowOn('2026-08-31').querySelector('.night-row-good')?.textContent).toBe('✦')
  })

  // The source the reader named goes with them, the same way the hero's panel and the Day tab take it.
  it('keeps the named source on each night\'s link, as the panel does', async () => {
    await renderAt(`${MONTH_URL}&source=watch`, { period: SLEEP_PERIOD_MONTH })
    const expected = `${nightPath('2026-08-31')}?source=watch`
    expect(cardFor('Nights')!.querySelector('a')!.getAttribute('href')).toBe(expected)
    act(() => { sparklines.get(HERO)!.onPointClick!('2026-08-31') })
    expect(container!.querySelector('.point-panel a')?.getAttribute('href')).toBe(expected)
  })

  it('leaves out bed to wake on a night missing either', async () => {
    const [night] = oneNight(-40, 425)
    await renderAt(MONTH_URL, { period: month({ nights: [{ ...night!, bedtimeMinutes: null }] }) })
    // The column stays, empty, so the rows under it keep their line.
    expect(cardFor('Nights')!.querySelector('.night-row-clock')?.textContent).toBe('')
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

  it('reads the stages\' axis in whole hours, and says what a bar is', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    const host = cardFor('De nachten')!.querySelector<HTMLDivElement>('div[role="img"]')!
    const option = echarts.getInstanceByDom(host)?.getOption() as { yAxis?: { name?: string, interval?: number, axisLabel?: { formatter?: (v: number) => string } }[] }
    const yAxis = option.yAxis![0]!
    expect(yAxis.interval).toBe(240)
    expect([0, 240, 480].map((v) => yAxis.axisLabel!.formatter!(v))).toEqual(['0u', '4u', '8u'])
    expect(yAxis.name ?? '').toBe('')
  })

  const stageLabels = () => {
    const host = cardFor('De nachten')!.querySelector<HTMLDivElement>('div[role="img"]')!
    const axis = (echarts.getInstanceByDom(host)?.getOption() as { xAxis: { data: string[], axisLabel: { interval: (i: number) => boolean } }[] }).xAxis[0]!
    return axis.data.filter((_, i) => axis.axisLabel.interval(i))
  }

  it('labels the stages by day number on a month and by month name on a year', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    expect(stageLabels()).toEqual(['1', '8', '15', '22', '29'])
    act(() => { root?.unmount() }); root = createRoot(container!)
    await renderAt(YEAR_URL, { period: SLEEP_PERIOD_YEAR }, 'nl')
    expect(stageLabels()).toEqual(['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'])
  })

  it('gives each stage\'s average and share in the legend, through the shared stage names', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH }, 'nl')
    const legend = [...cardFor('De nachten')!.querySelectorAll('.detail-legend li')].map((li) => li.textContent)
    expect(legend).toEqual(['Diep 1u 10m · 16 %', 'Licht 4u 10m · 58 %', 'REM 1u 25m · 20 %', 'Wakker 0u 28m · 6 %'])
  })

  it('opens the schedule with the variability and the weekend, the weekend\'s amounts bold', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const sentences = [...cardFor('Sleep schedule')!.querySelectorAll('.schedule-sentences p')]
    const variability = SLEEP_PERIOD_MONTH.schedule.variability!
    expect(sentences.map((sentence) => sentence.textContent)).toEqual([
      `Bedtime varied ±${variability.value} min this month · your usual ±${variability.usual!.low} – ${variability.usual!.high} min`,
      'At the weekend 6 min later to bed and 7 min later up',
    ])
    expect([...sentences[1]!.querySelectorAll('strong')].map((strong) => strong.textContent)).toEqual(['6 min later', '7 min later'])
    // The sentence replaces the variability row: no figure row in the card on a month.
    expect(cardFor('Sleep schedule')!.querySelector('.figure-row')).toBeNull()
  })

  it('says the variability alone where its usual is thin', async () => {
    const variability = { ...SLEEP_PERIOD_MONTH.schedule.variability!, usual: { ...SLEEP_PERIOD_MONTH.schedule.variability!.usual!, thin: true } }
    await renderAt(MONTH_URL, { period: month({ schedule: { ...SLEEP_PERIOD_MONTH.schedule, variability } }) }, 'nl')
    expect(cardFor('Slaapschema')!.querySelector('.schedule-sentences p')?.textContent).toBe(`Naar bed varieerde ±${variability.value} min deze maand`)
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
    // Aug 15 2026 is a Saturday: a weekend night, and a bedtime with no verdict, undotted.
    expect(placed()).toEqual([[0, 1384, 1840, 1, 0]])
    const table = [...container!.querySelectorAll('table.sr-only')].find((t) => t.textContent?.includes('Naps'))!
    expect(table.textContent).toContain('23:04')
  })

  // A day sleeper's main sleep ends on its own date, so its bed is 780 (13:00) and its wake 1200.
  it('draws a day sleeper\'s 13:00 to 20:00 as seven hours, not a day and seven hours', async () => {
    await renderAt(MONTH_URL, { period: month({ nights: oneNight(780, 1200) }) })
    expect(placed()).toEqual([[0, 780, 1200, 1, 0]])
  })

  const legend = () => [...cardFor('Sleep schedule')!.querySelectorAll('.detail-legend li')].map((li) => li.textContent)

  it('keys the weekdays, the weekend, a bedtime outside its usual and the usual band, and says what a bar is', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    expect(legend()).toEqual(['weekdays', 'weekend', 'bedtime outside your usual', 'your usual times'])
    expect(cardFor('Sleep schedule')!.querySelector('.dash-caption')?.textContent).toBe('bedtime and wake time, every night this month')
  })

  it('keys the usual band only when one is drawn, and a bedtime outside it only when a night has one', async () => {
    const unbanded = (figure: PeriodFigure | null) => figure && { ...figure, daily: figure.daily.map((point) => ({ ...point, band: null, standing: 'within' as const })) }
    const schedule = { ...SLEEP_PERIOD_MONTH.schedule, bedtime: unbanded(SLEEP_PERIOD_MONTH.schedule.bedtime), waketime: unbanded(SLEEP_PERIOD_MONTH.schedule.waketime) }
    await renderAt(MONTH_URL, { period: month({ schedule }) })
    expect(legend()).toEqual(['weekdays', 'weekend'])
  })

  // The weekend flag and the dot, off the chart's own series data: a Saturday or Sunday morning is
  // a weekend night (the server's rule for the sentence), and a bedtime the server put outside its
  // usual is dotted.
  it('marks each weekend night and each bedtime outside its usual in the chart\'s data', async () => {
    await renderAt(MONTH_URL, { period: SLEEP_PERIOD_MONTH })
    const rows = placed() as [number, number, number, number, number][]
    const oldestFirst = [...SLEEP_PERIOD_MONTH.nights].reverse()
    const out = new Set(SLEEP_PERIOD_MONTH.schedule.bedtime!.daily.filter((p) => p.standing === 'above' || p.standing === 'below').map((p) => p.from))
    expect(out.size).toBeGreaterThan(0)
    expect(rows.map((row) => row[3])).toEqual(oldestFirst.map((night) => (night.weekend ? 1 : 0)))
    expect(rows.map((row) => row[4])).toEqual(oldestFirst.map((night) => (out.has(night.localDate) ? 1 : 0)))
    // Aug 1 2026 is a Saturday, Aug 3 a Monday.
    expect(rows[oldestFirst.findIndex((night) => night.localDate === '2026-08-01')]![3]).toBe(1)
    expect(rows[oldestFirst.findIndex((night) => night.localDate === '2026-08-03')]![3]).toBe(0)
  })

  it("colours a night by the server's weekend flag, never by working the weekday out itself", async () => {
    // A Saturday morning the server did not flag stays a weekday night.
    await renderAt(MONTH_URL, { period: month({ nights: [{ ...oneNight(-56, 400)[0]!, weekend: false }] }) })
    expect((placed() as number[][])[0]![3]).toBe(0)
  })
})
