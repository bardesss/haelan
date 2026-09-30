// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { Activity } from '../src/pages/Activity.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { ActivityPeriodData, TypeTotal } from '../src/data/periodTypes.js'
import { ACTIVITY_PERIOD_EMPTY, ACTIVITY_PERIOD_MONTH, ACTIVITY_PERIOD_YEAR } from './fixtures/activityPeriod.js'
import { withQuery } from './sleepPageStub.js'
import { stubActivity } from './activityPageStub.js'
import type { ActivityStub } from './activityPageStub.js'
import { flush } from './flush.js'
import { seriesPoint } from './metricCoverage.js'

// The hero's and the figure rows' strips, stubbed so a test can read what each was handed and click
// a dot the way the chart would (sleep-page.test.tsx's own idiom). Keyed by the chart's label.
type SparklineProps = { label: string, values: (number | null)[], lastYear?: (number | null)[], onPointClick?: (label: string) => void }
const { sparklines } = vi.hoisted(() => ({ sparklines: new Map<string, SparklineProps>() }))
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: SparklineProps) => {
    sparklines.set(props.label, props)
    return <div data-sparkline={props.label} />
  },
}))

// The heatmap, stubbed the same way: a test reads the scale, the good day and the click it was handed.
type HeatmapProps = { label: string, max: number, good?: string | null, days: { date: string }[], onPointClick?: (localDate: string) => void }
const { heatmaps } = vi.hoisted(() => ({ heatmaps: [] as HeatmapProps[] }))
vi.mock('../src/charts/ActivityHeatmap.js', () => ({
  ActivityHeatmap: (props: HeatmapProps) => {
    heatmaps.push(props)
    return <div role="img" aria-label={props.label} />
  },
}))

// The bars and the zone bar draw for real, and echarts.init throws "missing chart token" without
// these.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null
let restore: () => void = () => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sparklines.clear()
  heatmaps.length = 0
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
const NB = ' '
const MONTH_URL = '/activity?range=month&on=2026-08-15'
const YEAR_URL = '/activity?range=year&on=2025-06-01'
const HERO = 'Steps, average per day'

/** Mounts the page at `path` over `stub`, settled; returns every URL it asked for. */
async function renderAt(path: string, stub: ActivityStub, lng = 'en'): Promise<string[]> {
  window.history.replaceState(null, '', path)
  const urls: string[] = []
  restore()
  restore = stubActivity(urls, stub)
  const { client, tree } = withQuery(<Activity />)
  act(() => { root?.render(<I18nProvider lng={lng}>{tree}</I18nProvider>) })
  await flush(client, () => container!.innerHTML)
  return urls
}

const cardFor = (label: string): HTMLElement | undefined => [...container!.querySelectorAll<HTMLElement>('section.card')]
  .find((card) => card.querySelector(':scope > .label')?.textContent === label)
const text = (): string => container!.textContent ?? ''
const heroLines = (): string[] => [...cardFor(HERO)!.querySelectorAll('.workout-hero-line')].map((line) => line.textContent ?? '')
const heroBold = (): string[] => [...cardFor(HERO)!.querySelectorAll('.workout-hero-line strong')].map((line) => line.textContent ?? '')
const month = (patch: Partial<ActivityPeriodData>): ActivityPeriodData => ({ ...ACTIVITY_PERIOD_MONTH, ...patch })
const typeRows = (): string[][] => [...cardFor('By type')!.querySelectorAll('.activity-type')].map((row) =>
  ['.activity-type-name', '.activity-type-amount', '.activity-type-verdict'].map((cell) => row.querySelector(cell)?.textContent ?? ''))
const rowNamed = (card: string, label: string): Element | undefined => [...cardFor(card)!.querySelectorAll('.figure-row')]
  .find((row) => row.querySelector('.figure-row-label')?.textContent === label)
const minisRow = (label: string): Element | undefined => [...container!.querySelectorAll('.detail-minis .figure-row')]
  .find((row) => row.querySelector('.figure-row-label')?.textContent === label)
const workoutRows = (): NodeListOf<Element> => cardFor('Workouts')!.querySelectorAll('.session-row')
const showAll = (): HTMLButtonElement => cardFor('Workouts')!.querySelector<HTMLButtonElement>('.period-list-toggle')!

// Enough workouts that the list has a "Show all": the fixture's ten, and five more copies of the
// newest, each its own id.
const MANY = [
  ...ACTIVITY_PERIOD_MONTH.workouts,
  ...[1, 2, 3, 4, 5].map((n) => ({ ...ACTIVITY_PERIOD_MONTH.workouts[0]!, id: `w-extra-${n}` })),
]
const types = (patch: Partial<TypeTotal>): TypeTotal[] => ACTIVITY_PERIOD_MONTH.types.map((type) => ({ ...type, ...patch }))

describe('the Activity page: header and requests', () => {
  it('names the period and the source in the header line, in both languages', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(container!.querySelector('h1')?.textContent).toBe('Activity')
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Aug 1 – 31, 2026 · All sources')
    act(() => { root?.unmount() })
    root = createRoot(container!)
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH }, 'nl')
    expect(container!.querySelector('.dash-date')?.textContent).toBe('1 – 31 aug 2026 · Alle bronnen')
  })

  it('names a picked source, and asks for it', async () => {
    const urls = await renderAt(`${MONTH_URL}&source=watch`, { period: ACTIVITY_PERIOD_MONTH })
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Aug 1 – 31, 2026 · My watch')
    expect(urls.some((url) => url.includes('/activity/period') && url.includes('source=watch'))).toBe(true)
  })

  it('exports the period\'s summed activity rollups', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const exported = new URLSearchParams(container!.querySelector('a[href*="/export?"]')!.getAttribute('href')!.split('?')[1])
    expect(exported.getAll('metric')).toContain('steps')
    expect([exported.get('agg'), exported.get('from'), exported.get('to')]).toEqual(['sum', '2026-08-01', '2026-08-31'])
  })

  // The page stays mounted once the URL moves (no router swaps it for the dashboard), so it goes on
  // to read the URL's defaults; what it must never do is ask for a period on that day.
  it('opens the dashboard on that day for the Day tab, dropping the source, and asks for no period', async () => {
    const urls = await renderAt('/activity?range=day&on=2026-08-15&source=watch', { period: ACTIVITY_PERIOD_MONTH })
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?day=2026-08-15')
    expect(urls.filter((url) => url.includes('/activity/period') && url.includes('anchor=2026-08-15'))).toEqual([])
  })

  it('makes one period read per mount, and asks nothing from /series or /insights', async () => {
    const urls = await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(urls.filter((url) => url.includes('/activity/period'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('/series') || url.includes('/insights'))).toEqual([])
  })

  it('keeps the header over an error, and over an empty period says there are no activities', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH, status: 400 })
    expect(container!.querySelector('h1')?.textContent).toBe('Activity')
    expect(container!.querySelector('.controls')).not.toBeNull()
    expect(cardFor(HERO)).toBeUndefined()
    expect(container!.querySelector('.empty .button')?.textContent).toBe('Try again')
    act(() => { root?.unmount() })
    root = createRoot(container!)
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_EMPTY })
    expect(container!.querySelector('h1')?.textContent).toBe('Activity')
    expect(container!.querySelector('.empty')?.textContent).toContain('No activities recorded in this period.')
    expect(container!.querySelectorAll('section.card')).toHaveLength(1)
  })

  // A period with no steps but a workout still has something to show.
  it('draws the workouts of a period with no steps', async () => {
    await renderAt(MONTH_URL, { period: { ...ACTIVITY_PERIOD_EMPTY, workouts: ACTIVITY_PERIOD_MONTH.workouts } })
    expect(container!.querySelector('.empty')).toBeNull()
    expect(cardFor('Workouts')).toBeDefined()
  })

  it('carries no percentage change, no insight card, no percentage note and none of the old tiles', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(container!.querySelector('.delta')).toBeNull()
    expect(container!.querySelector('.insight-summary')).toBeNull()
    expect(container!.querySelector('.control-row-note')).toBeNull()
    expect(container!.querySelector('.zone-tiles')).toBeNull()
    expect(cardFor('Training load')).toBeUndefined()
    expect(text()).not.toMatch(/[+\-−]\d+(?:[.,]\d+)?\s?%/)
  })
})

describe('the Activity page: the hero', () => {
  it('leads with the steps per day against the usual for a month, the day counts and what stood out', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const hero = cardFor(HERO)!
    expect(hero.querySelector('.detail-hero-value')?.textContent).toBe('7,932')
    expect(hero.querySelector('.detail-verdict')?.textContent).toBe('within your usual 7,912 – 8,037 for a month, last 12 months')
    expect(heroLines()).toEqual(['15 of 28 days usual · 6 higher · 7 lower', 'busiest: 10,700 on Sun, Aug 23 ✦', '-32 a day against July'])
    expect(heroBold()).toEqual(['10,700', '-32'])
    expect(hero.querySelector('.period-hero-captions')?.textContent).toBe('every day this monthtap a day for the figures')
  })

  it('says the change against last year with the comparison on, and overlays last year\'s steps', async () => {
    const urls = await renderAt(`${MONTH_URL}&compare=year`, {
      period: ACTIVITY_PERIOD_MONTH,
      series: () => ({ steps: { points: [seriesPoint('steps', '2025-08-05', 6400)], reduction: null } }),
    })
    expect(heroLines()).toEqual([
      '15 of 28 days usual · 6 higher · 7 lower', 'busiest: 10,700 on Sun, Aug 23 ✦', '-32 a day against July', '-75 a day against last year',
    ])
    const asked = urls.filter((url) => url.includes('/series'))
    expect(asked).toHaveLength(1)
    expect(new URLSearchParams(asked[0]!.split('?')[1]).getAll('metric')).toEqual(['steps'])
    const lastYear = sparklines.get(HERO)!.lastYear!
    expect(lastYear[4]).toBe(6400)
    expect(lastYear).toHaveLength(ACTIVITY_PERIOD_MONTH.hero.daily.length)
  })

  it('draws weekly points on a year, says so, and asks no /series with the comparison on', async () => {
    const urls = await renderAt(`${YEAR_URL}&compare=year`, { period: ACTIVITY_PERIOD_YEAR })
    expect(sparklines.get(HERO)!.values).toHaveLength(ACTIVITY_PERIOD_YEAR.hero.weekly!.length)
    expect(cardFor(HERO)!.querySelector('.period-hero-captions')?.textContent)
      .toBe(`each point is a week, the average of its days · ${ACTIVITY_PERIOD_YEAR.hero.weekly!.length} weekstap a week for the figures`)
    expect(urls.filter((url) => url.includes('/series'))).toEqual([])
  })

  it('opens a day\'s panel with its steps, active minutes and distance, the day, and the annotate on steps', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    act(() => { sparklines.get(HERO)!.onPointClick!('2026-08-01') })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelector('.point-panel-title')?.textContent).toBe('Saturday, August 1')
    const labels = [...panel.querySelectorAll('.point-panel-row dt')].map((cell) => cell.textContent)
    expect(labels).toEqual(['Steps', 'Active minutes', 'Distance'])
    expect(panel.querySelector('.point-panel-value')?.textContent).toBe('8,600')
    expect(panel.querySelector('a.card-link')?.getAttribute('href')).toBe('/?day=2026-08-01')
    expect(panel.querySelector('a.card-link')?.textContent).toBe('View day')
    act(() => { panel.querySelector<HTMLButtonElement>('.point-panel-actions .button')!.click() })
    expect(container!.querySelector('.point-panel')).toBeNull()
    expect(document.querySelector('.annotate-panel')).not.toBeNull()
  })

  it('opens a week\'s panel on a year with its steps alone and nowhere to go', async () => {
    await renderAt(YEAR_URL, { period: ACTIVITY_PERIOD_YEAR })
    const week = ACTIVITY_PERIOD_YEAR.hero.weekly![3]!
    act(() => { sparklines.get(HERO)!.onPointClick!(week.from) })
    const panel = container!.querySelector('.point-panel')!
    expect([...panel.querySelectorAll('.point-panel-row dt')].map((cell) => cell.textContent)).toEqual(['Steps'])
    expect(panel.querySelector('a.card-link')).toBeNull()
  })
})

describe('the Activity page: the figures', () => {
  it('labels each average by what it is an average of, and prints the totals with their day\'s average', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const minis = container!.querySelector('.detail-minis')!
    const labels = [...minis.querySelectorAll('.figure-row-label')].map((label) => label.textContent)
    expect(labels).toEqual(['Active minutes, per week', 'Distance', 'floors', 'Active energy, per day'])
    const active = [...minis.querySelectorAll('.figure-row')][0]!
    expect(active.querySelector('.figure-row-value')?.textContent).toBe(`1,502${NB}min`)
    expect(active.querySelector('.figure-row-verdict')?.textContent).toBe(`within your usual 1,497 – 1,506${NB}min per week`)
    const distance = [...minis.querySelectorAll('.figure-row')][1]!
    expect(distance.querySelector('.figure-row-value')?.textContent).toBe(`147${NB}km`)
    // A total is judged as a total, against the usual for a month's total, and says so.
    expect(distance.querySelector('.figure-row-verdict')?.textContent).toBe(`within your usual 146 – 152${NB}km for a month`)
    // A total's note is its average alone, with no day counts.
    expect(distance.querySelector('.figure-row-note')?.textContent).toBe(`5.3${NB}km per day on average`)
    expect(minis.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every day this month, active minutes too · distance and floors add up the period · band = your usual range')
  })

  it("says a running period's total is so far, beside a whole month's usual for it", async () => {
    const figures = ACTIVITY_PERIOD_MONTH.figures.map((f) => (f.metric === 'distance' ? { ...f, totalStanding: null, totalJudged: null } : f))
    await renderAt(MONTH_URL, { period: month({ figures }) })
    expect(minisRow('Distance')!.querySelector('.figure-row-verdict')?.textContent)
      .toBe(`so far; usual 146 – 152${NB}km a month`)
  })

  it("takes a total's tone from its total's verdict, not from its average's", async () => {
    const more = ACTIVITY_PERIOD_MONTH.more.map((f) => (f.metric === 'altitude_gain' ? { ...f, standing: 'within' as const, judged: null } : f))
    await renderAt(MONTH_URL, { period: month({ more }) })
    const verdict = rowNamed('More about moving', 'Elevation gain')!.querySelector('.figure-row-verdict')!
    expect(verdict.textContent).toBe(`below your usual 522 – 551${NB}m for a month`)
    expect(verdict.className).toBe('figure-row-verdict worse')
  })

  it('leaves out the four figures when none has a value', async () => {
    await renderAt(MONTH_URL, { period: month({ figures: ACTIVITY_PERIOD_MONTH.figures.map((f) => ({ ...f, value: null })) }) })
    expect(container!.querySelector('.detail-minis')).toBeNull()
  })

  it('says the figures\' lines are weekly on a year', async () => {
    await renderAt(YEAR_URL, { period: ACTIVITY_PERIOD_YEAR })
    expect(container!.querySelector('.detail-minis')!.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every week, the average of its days · distance and floors add up the period · band = your usual range')
  })

  it('prints Dutch in the usual words and durations', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH }, 'nl')
    expect(cardFor('Stappen, gemiddeld per dag')!.querySelector('.detail-verdict')?.textContent)
      .toBe('binnen je gebruikelijke bereik 7.912 – 8.037 voor een maand, afgelopen 12 maanden')
    expect(minisRow('Afstand')!.querySelector('.figure-row-verdict')?.textContent)
      .toBe(`binnen je gebruikelijke bereik 146 – 152${NB}km voor een maand`)
    expect(rowNamed('Meer over bewegen', 'Trainingstijd')!.querySelector('.figure-row-value')?.textContent).toBe(`16u${NB}01m`)
    expect(text()).toContain('gebruikelijk')
  })
})

describe('the Activity page: sections', () => {
  it('draws every section from the month fixture, and no heatmap on a month', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    for (const label of [HERO, 'Active minutes by intensity', 'Active Zone Minutes', 'Heart-rate zones', 'Workouts', 'By type', 'More about moving']) {
      expect(cardFor(label), label).toBeDefined()
    }
    expect(cardFor('Steps per day')).toBeUndefined()
    for (const label of ['Active Zone Minutes', 'Heart-rate zones', 'Workouts', 'By type']) expect(cardFor(label)!.dataset.span, label).toBe('6')
  })

  it('draws the heatmap of every day on a year, and a day opens the dashboard on it', async () => {
    await renderAt(YEAR_URL, { period: ACTIVITY_PERIOD_YEAR })
    const card = cardFor('Steps per day')!
    expect(card.querySelector('div[role="img"][aria-label="Steps per day"]')).not.toBeNull()
    expect(card.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('every day this year · a square per day, a column per week · tap a day to open it')
    const heatmap = heatmaps.at(-1)!
    expect(heatmap.days).toHaveLength(365)
    // The scale runs to the server's busiest day; not a good one, so nothing is ringed.
    expect([heatmap.max, heatmap.good]).toEqual([ACTIVITY_PERIOD_YEAR.high!.value, null])
    act(() => { heatmap.onPointClick!('2025-03-04') })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?day=2025-03-04')
  })

  it("rings the busiest day on the heatmap when the server judged it good, and the caption names it ✦, in both languages", async () => {
    const period = { ...ACTIVITY_PERIOD_YEAR, high: { ...ACTIVITY_PERIOD_YEAR.high!, good: true } }
    await renderAt(YEAR_URL, { period })
    expect(heatmaps.at(-1)!.good).toBe(ACTIVITY_PERIOD_YEAR.high!.localDate)
    expect(cardFor('Steps per day')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('every day this year · a square per day, a column per week · ✦ your busiest day · tap a day to open it')
    await renderAt(YEAR_URL, { period }, 'nl')
    expect(cardFor('Stappen per dag')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('elke dag dit jaar · een vakje per dag, een kolom per week · ✦ je drukste dag · tik op een dag om hem te openen')
  })

  it('draws the heatmap on 3 months too', async () => {
    await renderAt('/activity?range=3months&on=2025-06-01', { period: { ...ACTIVITY_PERIOD_YEAR, period: { ...ACTIVITY_PERIOD_YEAR.period, range: '3months' } } })
    expect(cardFor('Steps per day')).toBeDefined()
  })

  it('stacks the active minutes by intensity, with each band\'s total and what a bar is', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const card = cardFor('Active minutes by intensity')!
    expect([...card.querySelectorAll('.detail-legend li')].map((li) => li.textContent))
      .toEqual([`Light 5,021${NB}min`, `Moderate 766${NB}min`, `Vigorous 219${NB}min`])
    expect([...card.querySelectorAll('.detail-legend-key')].map((key) => (key as HTMLElement).dataset.activity)).toEqual(['light', 'moderate', 'vigorous'])
    expect(card.querySelector(':scope > .dash-caption')?.textContent).toBe('every day this month · minutes per band of movement, from your steps')
  })

  it('says a bar is a week\'s daily average on a year', async () => {
    await renderAt(YEAR_URL, { period: ACTIVITY_PERIOD_YEAR })
    expect(cardFor('Active minutes by intensity')!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('every week, as a day\'s average · minutes per band of movement, from your steps')
  })

  it('leads the zone minutes with their total and verdict, and the heart-rate zones with the time vigorous or peak', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const azm = cardFor('Active Zone Minutes')!
    expect(azm.querySelector('.dash-headline')?.textContent).toBe(`685${NB}min`)
    expect(azm.querySelector('.detail-verdict')?.textContent).toBe(`within your usual 684 – 714${NB}min for a month`)
    expect([...azm.querySelectorAll('.detail-legend li')].map((li) => li.textContent)).toEqual(['Fat burn 429', 'Cardio 205', 'Peak 51'])
    expect([...azm.querySelectorAll('.detail-legend-key')].map((key) => (key as HTMLElement).dataset.azm)).toEqual(['fatBurn', 'cardio', 'peak'])
    const zones = cardFor('Heart-rate zones')!
    expect(zones.querySelector('.dash-headline')?.textContent).toBe(`5h${NB}36m`)
    expect(zones.querySelector('.workout-hero-line')?.textContent)
      .toBe(`vigorous or peak · within your usual 5h${NB}28m – 5h${NB}46m for a month`)
    expect([...zones.querySelectorAll('.detail-legend li')].map((li) => li.textContent))
      .toEqual([`Light 107h${NB}01m`, `Moderate 18h${NB}01m`, `Vigorous 4h${NB}55m`, `Peak 41${NB}min`])
    expect(zones.querySelector('div[role="img"]')).not.toBeNull()
  })

  it("tones the zone minutes by their total's verdict, not their average's", async () => {
    const more = ACTIVITY_PERIOD_MONTH.more.map((f) => (f.metric === 'active_zone_minutes'
      ? { ...f, standing: 'within' as const, judged: null, totalStanding: 'above' as const, totalJudged: 'better' as const } : f))
    await renderAt(MONTH_URL, { period: month({ more }) })
    const verdict = cardFor('Active Zone Minutes')!.querySelector('.detail-verdict')!
    expect(verdict.textContent).toBe(`above your usual 684 – 714${NB}min for a month`)
    expect(verdict.className).toBe('detail-verdict better')
  })

  it("prints the server's hard-zone total, never the zones' own sum, with its total's tone", async () => {
    const hard = { ...ACTIVITY_PERIOD_MONTH.heartRateZones.hard, total: 400, totalStanding: 'above' as const, totalJudged: 'better' as const }
    await renderAt(MONTH_URL, { period: month({ heartRateZones: { ...ACTIVITY_PERIOD_MONTH.heartRateZones, hard } }) })
    const zones = cardFor('Heart-rate zones')!
    expect(zones.querySelector('.dash-headline')?.textContent).toBe(`6h${NB}40m`)
    const verdict = zones.querySelector('.workout-hero-line .detail-verdict')!
    expect(verdict.textContent).toBe(`above your usual 5h${NB}28m – 5h${NB}46m for a month`)
    expect(verdict.className).toBe('detail-verdict better')
  })

  it("rows the day's highest heart rate in the heart-rate zones, in both languages", async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const row = rowNamed('Heart-rate zones', 'Highest heart rate, per day')!
    expect(row.querySelector('.figure-row-value')?.textContent).toBe(`164${NB}bpm`)
    expect(row.querySelector('.figure-row-verdict')?.textContent).toBe(`within your usual 163 – 165${NB}bpm`)
    act(() => { root?.unmount() })
    root = createRoot(container!)
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH }, 'nl')
    const nl = rowNamed('Hartslagzones', 'Hoogste hartslag, per dag')!
    expect(nl.querySelector('.figure-row-verdict')?.textContent).toBe(`binnen je gebruikelijke bereik 163 – 165${NB}bpm`)
  })

  it('keeps the heart-rate card for the highest heart rate alone, with no zones', async () => {
    const none = { light: null, moderate: null, vigorous: null, peak: null, hard: null }
    await renderAt(MONTH_URL, { period: month({ heartRateZones: none }) })
    const zones = cardFor('Heart-rate zones')!
    expect(zones.querySelector('.dash-headline')).toBeNull()
    expect(zones.querySelector('div[role="img"]')).toBeNull()
    expect(rowNamed('Heart-rate zones', 'Highest heart rate, per day')).toBeDefined()
    // The caption speaks of time in each zone, so it goes with them.
    expect(zones.querySelector('.dash-caption')).toBeNull()
  })

  it('captions the zones with where their time comes from', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(cardFor('Heart-rate zones')!.querySelector('.dash-caption')?.textContent)
      .toBe('time in each zone over this month, from your heart rate through the whole day')
  })

  it.each<[string, string, Partial<ActivityPeriodData>]>([
    ['Active Zone Minutes', 'Heart-rate zones', { zoneMinutes: { fatBurn: null, cardio: null, peak: null } }],
    ['Heart-rate zones', 'Active Zone Minutes', { heartRateZones: { light: null, moderate: null, vigorous: null, peak: null, hard: null }, maxHeartRate: null }],
    ['Workouts', 'By type', { workouts: [] }],
    ['By type', 'Workouts', { types: [], cardioLoad: null, vo2max: null }],
  ])('leaves out %s when its data is absent, and %s takes the whole row', async (gone, partner, patch) => {
    await renderAt(MONTH_URL, { period: month(patch) })
    expect(cardFor(gone)).toBeUndefined()
    expect(cardFor(partner)!.dataset.span).toBe('12')
  })

  it.each<[string, Partial<ActivityPeriodData>]>([
    ['Active minutes by intensity', { intensity: { light: null, moderate: null, vigorous: null } }],
    ['More about moving', { more: [] }],
  ])('leaves out %s when its data is absent', async (gone, patch) => {
    await renderAt(MONTH_URL, { period: month(patch) })
    expect(cardFor(gone)).toBeUndefined()
  })

  it('keeps the zone minutes out of More about moving, and names the workouts under workout time', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const labels = [...cardFor('More about moving')!.querySelectorAll('.figure-row-label')].map((label) => label.textContent)
    expect(labels).toEqual(['Total calories, per day', 'Workout time', 'Elevation gain', 'Sedentary, per day'])
    expect(rowNamed('More about moving', 'Workout time')!.querySelector('.figure-row-note')?.textContent).toBe(`0h${NB}34m per day on average · 9 workouts`)
    expect(rowNamed('More about moving', 'Elevation gain')!.querySelector('.figure-row-value')?.textContent).toBe(`521${NB}m`)
  })
})

describe('the Activity page: the workouts', () => {
  it('lists the newest first with their date, under the server\'s count and the period\'s workout time', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    const card = cardFor('Workouts')!
    expect(card.querySelector('.dash-caption')?.textContent)
      .toBe(`newest first · 9 workouts this month, 16h${NB}01m together · excluded workouts do not count`)
    expect(workoutRows()).toHaveLength(7)
    expect(workoutRows()[0]!.querySelector('.session-row-detail')?.textContent).toMatch(/^Sat, Aug 29 · /)
    expect(showAll().textContent).toBe('Show all 10 workouts')
    expect(card.querySelector('.activity-workout-filter')).toBeNull()
  })

  it('takes a row of its own when expanded, the types widening with it', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    act(() => { showAll().click() })
    expect(workoutRows()).toHaveLength(ACTIVITY_PERIOD_MONTH.workouts.length)
    expect(cardFor('Workouts')!.dataset.span).toBe('12')
    expect(cardFor('By type')!.dataset.span).toBe('12')
    // A month's list is not grouped.
    expect(cardFor('Workouts')!.querySelector('.period-list-heading')).toBeNull()
  })

  it('filters the expanded list by type, and clears it on closing', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    act(() => { showAll().click() })
    const chips = () => [...cardFor('Workouts')!.querySelectorAll<HTMLButtonElement>('.activity-workout-filter .segment')]
    // "All" names the rows it shows, the excluded one among them; each type its count as the server counts.
    expect(chips().map((chip) => chip.textContent)).toEqual(['All 10', 'Biking 3', 'Running 3', 'Walking 3'])
    expect(chips()[0]!.getAttribute('aria-pressed')).toBe('true')
    act(() => { chips()[2]!.click() })
    const running = ACTIVITY_PERIOD_MONTH.workouts.filter((w) => w.type === 'RUNNING')
    expect(workoutRows()).toHaveLength(running.length)
    for (const row of workoutRows()) expect(row.querySelector('.session-row-type')?.textContent).toBe('Running')
    // Fewer than seven, and still open, with its way closed.
    expect(showAll().textContent).toBe('Show fewer')
    act(() => { showAll().click() })
    expect(cardFor('Workouts')!.querySelector('.activity-workout-filter')).toBeNull()
    expect(workoutRows()).toHaveLength(7)
  })

  it("groups the list by month on a year, collapsed as well, each month's workouts counted on the right", async () => {
    await renderAt(YEAR_URL, { period: ACTIVITY_PERIOD_YEAR })
    const card = cardFor('Workouts')!
    // Collapsed: seven rows under their month headings, and the list not opened.
    expect(workoutRows()).toHaveLength(7)
    expect(card.querySelector('.period-list-expanded')).toBeNull()
    expect(showAll().getAttribute('aria-expanded')).toBe('false')
    expect([...card.querySelectorAll('.period-list-heading')].map((h) => h.textContent)).toEqual(['December7 workouts'])
    await renderAt(YEAR_URL, { period: ACTIVITY_PERIOD_YEAR }, 'nl')
    expect(cardFor('Trainingen')!.querySelector('.period-list-aside')?.textContent).toBe('7 trainingen')
  })

  it('names no count on a month with only excluded workouts', async () => {
    await renderAt(YEAR_URL, { period: { ...ACTIVITY_PERIOD_YEAR, workoutMonths: ACTIVITY_PERIOD_YEAR.workoutMonths.slice(1) } })
    const heading = cardFor('Workouts')!.querySelector('.period-list-heading')!
    expect(heading.querySelector('.period-list-name')?.textContent).toBe('December')
    expect(heading.querySelector('.period-list-aside')).toBeNull()
  })

  it("prints a workout's pace and climb on its row", async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(workoutRows()[0]!.querySelector('.session-row-detail')?.textContent).toBe(`Sat, Aug 29 · 3.00${NB}km · 9:00${NB}/km · 25${NB}m${NB}gained`)
  })

  it("prints a ride's speed on its row, in km/u in Dutch, and never its pace", async () => {
    const [first, ...rest] = ACTIVITY_PERIOD_MONTH.workouts
    // A ride with no device pace: the row prints the speed core sends, 8.33 m/s being 30 km an hour.
    await renderAt(MONTH_URL, { period: month({ workouts: [{ ...first!, type: 'BIKING', paceSecondsPerKm: null, speedMetersPerSecond: 8.33 }, ...rest] }) }, 'nl')
    expect(cardFor('Trainingen')!.querySelector('.session-row-detail')?.textContent).toBe(`za 29 aug · 3,00${NB}km · 30,0${NB}km/u · 25${NB}m${NB}omhoog`)
  })

  it('opens collapsed again in a new period', async () => {
    await renderAt(MONTH_URL, { period: month({ workouts: MANY }) })
    act(() => { showAll().click() })
    expect(workoutRows()).toHaveLength(MANY.length)
    // The stub answers every period with the same body, so only the period key tells them apart.
    act(() => { container!.querySelector<HTMLButtonElement>('button[aria-label="Previous period"]')!.click() })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(new URLSearchParams(window.location.search).get('on')).not.toBe('2026-08-15')
    expect(workoutRows()).toHaveLength(7)
  })
})

describe('the Activity page: by type', () => {
  it('counts each type against its usual for a month, with its distance', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(cardFor('By type')!.querySelector('.dash-caption')?.textContent).toBe('this month · against your usual month')
    expect(typeRows()).toEqual([
      ['Biking', `3${NB}× · 12.0${NB}km`, 'within your usual 2 – 3'],
      ['Running', `3${NB}× · 10.2${NB}km`, 'within your usual 2 – 3'],
      ['Walking', `3${NB}× · 11.4${NB}km`, 'within your usual 2 – 3'],
    ])
  })

  it('colours more workouts of a type than usual green and fewer red, as the server judges them', async () => {
    const [first, second] = ACTIVITY_PERIOD_MONTH.types
    await renderAt(MONTH_URL, { period: month({ types: [
      { ...first!, standing: 'above', judged: 'better' }, { ...second!, standing: 'below', judged: 'worse' },
    ] }) })
    const verdicts = [...cardFor('By type')!.querySelectorAll('.activity-type-verdict')]
    expect(verdicts.map((v) => [v.textContent, v.className])).toEqual([
      ['above your usual 2 – 3', 'activity-type-verdict better'],
      ['below your usual 2 – 3', 'activity-type-verdict worse'],
    ])
  })

  it('gives no verdict while the period is running, says a thin usual is thin, and says when there is no usual', async () => {
    const [first, second, third] = ACTIVITY_PERIOD_MONTH.types
    await renderAt(MONTH_URL, {
      period: month({ types: [{ ...first!, standing: null }, { ...second!, usualCount: { ...second!.usualCount!, thin: true } }, { ...third!, usualCount: null, standing: null }] }),
    })
    expect(typeRows().map((row) => row[2])).toEqual(['', 'not enough history for a usual yet', 'no usual yet'])
  })

  it("prints a swim's distance in metres, and every other type's in kilometres", async () => {
    const [first, second] = ACTIVITY_PERIOD_MONTH.types
    await renderAt(MONTH_URL, { period: month({ types: [{ ...first!, type: 'SWIMMING_POOL', distanceMeters: 4500 }, second!] }) })
    expect(typeRows().map((row) => row.slice(0, 2))).toEqual([
      ['Swimming pool', `3${NB}× · 4,500${NB}m`],
      ['Running', `3${NB}× · 10.2${NB}km`],
    ])
  })

  it('prints a type\'s time where it has no distance', async () => {
    await renderAt(MONTH_URL, { period: month({ types: [{ ...ACTIVITY_PERIOD_MONTH.types[0]!, type: 'WEIGHTLIFTING', distanceMeters: null, seconds: 3240 }] }) })
    expect(typeRows()[0]!.slice(0, 2)).toEqual(['Weightlifting', `3${NB}× · 54${NB}min`])
  })

  it('shows the cardio load against its usual, and the VO₂max with its trend, in both languages', async () => {
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH })
    expect(rowNamed('By type', 'Cardio load, per day')!.querySelector('.figure-row-value')?.textContent).toBe('69')
    const vo2 = rowNamed('By type', 'VO₂max')!
    expect(vo2.querySelector('.figure-row-value')?.textContent).toBe('42.5')
    expect(vo2.querySelector('.figure-row-verdict')?.textContent).toBe('rising · was 40 in May')
    expect(vo2.querySelector('.figure-row-note')?.textContent).toBe('VO2 max (daily)')
    act(() => { root?.unmount() })
    root = createRoot(container!)
    await renderAt(MONTH_URL, { period: ACTIVITY_PERIOD_MONTH }, 'nl')
    expect(rowNamed('Per soort', 'VO₂max')!.querySelector('.figure-row-verdict')?.textContent).toBe('stijgend · was 40 in mei')
  })

  it('draws no verdict line for a VO₂max with no trend', async () => {
    await renderAt(MONTH_URL, { period: month({ vo2max: { ...ACTIVITY_PERIOD_MONTH.vo2max!, trend: null, earlier: null, earlierDate: null } }) })
    const vo2 = rowNamed('By type', 'VO₂max')!
    expect(vo2.querySelector('.figure-row-value')?.textContent).toBe('42.5')
    expect(vo2.querySelector('.figure-row-verdict')).toBeNull()
  })

  it.each<[string, Partial<ActivityPeriodData['vo2max'] & object>, string]>([
    ['falling', { trend: 'falling', latest: 38, earlier: 40 }, 'falling · was 40 in May'],
    ['steady', { trend: 'steady', latest: 42, earlier: 42 }, 'steady at 42'],
  ])('words a %s VO₂max', async (_, patch, words) => {
    await renderAt(MONTH_URL, { period: month({ vo2max: { ...ACTIVITY_PERIOD_MONTH.vo2max!, ...patch } }) })
    expect(rowNamed('By type', 'VO₂max')!.querySelector('.figure-row-verdict')?.textContent).toBe(words)
  })
})
