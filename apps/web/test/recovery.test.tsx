// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { bandOf } from '@haelan/core/recovery-index'
import { Recovery } from '../src/pages/Recovery.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { RecoveryPeriodData } from '../src/data/periodTypes.js'
import { RECOVERY_PERIOD_MONTH, RECOVERY_PERIOD_YEAR } from './fixtures/recoveryPeriod.js'
import { PERSON, WATCH, withQuery } from './sleepPageStub.js'
import { flush } from './flush.js'
import { seriesPoint } from './metricCoverage.js'

// The hero's and the figure rows' strips, stubbed so a test can read what each was handed and click
// a dot the way the chart would (activity.test.tsx's own idiom). Keyed by the chart's label.
type SparklineProps = { label: string, values: (number | null)[], onPointClick?: (label: string) => void }
const { sparklines } = vi.hoisted(() => ({ sparklines: new Map<string, SparklineProps>() }))
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: SparklineProps) => {
    sparklines.set(props.label, props)
    return <div data-sparkline={props.label} />
  },
}))

// The heart rate range draws for real, and echarts.init throws "missing chart token" without these.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

/** Stubs every route the page calls; every URL asked is pushed to `urls`. Returns the restore. */
function stubRecovery(urls: string[], period: RecoveryPeriodData, status?: number): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/recovery/period')) return status === undefined ? json(period) : json({ error: 'refused' }, status)
    // The heart rate range card's own three reads, one day of heart rate each.
    if (url.includes('/series')) {
      const body: Record<string, unknown> = {}
      for (const metric of new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')) {
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    if (url.includes('/sources')) return json({ items: [WATCH] })
    if (url.includes('/overrides') || url.includes('/notes') || url.includes('/events')) return json({ items: [] })
    if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
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

const MONTH_URL = '/recovery?range=month&on=2026-08-15'
const YEAR_URL = '/recovery?range=year&on=2025-06-01'
const HERO = 'Recovery index, average per day'
const HERO_NL = 'Herstelindex, gemiddeld per dag'

/** Mounts the page at `path` over `period`, settled; returns every URL it asked for. */
async function renderAt(path: string, period: RecoveryPeriodData, lng = 'en', status?: number): Promise<string[]> {
  act(() => { root?.unmount() })
  root = createRoot(container!)
  window.history.replaceState(null, '', path)
  const urls: string[] = []
  restore()
  restore = stubRecovery(urls, period, status)
  const { client, tree } = withQuery(<Recovery />)
  act(() => { root?.render(<I18nProvider lng={lng}>{tree}</I18nProvider>) })
  await flush(client, () => container!.innerHTML)
  return urls
}

const cardFor = (label: string): HTMLElement | undefined => [...container!.querySelectorAll<HTMLElement>('section.card')]
  .find((card) => card.querySelector(':scope > .label')?.textContent === label)
const heroLines = (label = HERO): string[] => [...cardFor(label)!.querySelectorAll('.workout-hero-line')].map((line) => line.textContent ?? '')
const heroBold = (label = HERO): string[] => [...cardFor(label)!.querySelectorAll('.workout-hero-line strong')].map((line) => line.textContent ?? '')
const sourceCaption = (label = HERO): string | null => cardFor(label)!.querySelector('.period-hero-source')?.textContent ?? null
const month = (patch: Partial<RecoveryPeriodData>): RecoveryPeriodData => ({ ...RECOVERY_PERIOD_MONTH, ...patch })

// YEAR's usual is thin (no 2024 behind it); a judged year, for the sentences a judged hero says.
const JUDGED_YEAR: RecoveryPeriodData = {
  ...RECOVERY_PERIOD_YEAR,
  hero: {
    ...RECOVERY_PERIOD_YEAR.hero, reason: null, standing: 'within', judged: null,
    usual: { center: 50, low: 47, high: 52, thin: false, window: { unit: 'year', count: 1, from: '2024-01-01', to: '2024-12-31' }, periods: 4 },
  },
  previous: { from: '2024-01-01', to: '2024-12-31', value: 47, delta: 2 },
  yearEarlier: { from: '2024-01-01', to: '2024-12-31', value: 47, delta: 2 },
}

describe('the Recovery page: header and requests', () => {
  it('names the period and the source in the header line, and makes one period read', async () => {
    const urls = await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    expect(container!.querySelector('h1')?.textContent).toBe('Recovery')
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Aug 1 – 31, 2026 · All sources')
    expect(urls.filter((url) => url.includes('/recovery/period'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('/insights'))).toEqual([])
    // /series is the heart rate range card's alone: the index is the server's, scored on no client.
    const series = urls.filter((url) => url.includes('/series')).map((url) => new URLSearchParams(url.split('?')[1]).getAll('metric'))
    expect(series.flat().every((metric) => metric === 'heart_rate')).toBe(true)
  })

  it('names a picked source, and asks for it', async () => {
    const urls = await renderAt(`${MONTH_URL}&source=watch`, RECOVERY_PERIOD_MONTH)
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Aug 1 – 31, 2026 · My watch')
    expect(urls.some((url) => url.includes('/recovery/period') && url.includes('source=watch'))).toBe(true)
  })

  it('exports the three figures\' daily readings', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    const exported = new URLSearchParams(container!.querySelector('a[href*="/export?"]')!.getAttribute('href')!.split('?')[1])
    expect(exported.getAll('metric')).toEqual(['resting_heart_rate', 'daily_hrv', 'respiratory_rate', 'sleep_respiratory_rate'])
    expect([exported.get('agg'), exported.get('from'), exported.get('to')]).toEqual(['last', '2026-08-01', '2026-08-31'])
  })

  // The page stays mounted once the URL moves (no router swaps it for the dashboard), so it goes on
  // to read the URL's defaults; what it must never do is ask for a period on that day.
  it('opens the dashboard on that day for the Day tab, dropping the source, and asks for no period', async () => {
    const urls = await renderAt('/recovery?range=day&on=2026-08-15&source=watch', RECOVERY_PERIOD_MONTH)
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?day=2026-08-15')
    expect(urls.filter((url) => url.includes('/recovery/period') && url.includes('anchor=2026-08-15'))).toEqual([])
  })

  it('keeps the header over an error, and over a period with nothing scored says so', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH, 'en', 400)
    expect(container!.querySelector('h1')?.textContent).toBe('Recovery')
    expect(cardFor(HERO)).toBeUndefined()
    expect(container!.querySelector('.empty .button')?.textContent).toBe('Try again')
    const empty = month({
      hero: { ...RECOVERY_PERIOD_MONTH.hero, value: null, days: 0 },
      figures: RECOVERY_PERIOD_MONTH.figures.map((figure) => ({ ...figure, value: null, days: 0 })),
    })
    await renderAt(MONTH_URL, empty)
    expect(container!.querySelector('h1')?.textContent).toBe('Recovery')
    expect(container!.querySelector('.empty')?.textContent)
      .toBe('No recovery index for this periodThe index needs HRV and resting heart rate readings, each against your own previous 60 days.')
    expect(container!.querySelectorAll('section.card')).toHaveLength(1)
  })

  it('carries no percentage change, no insight card, no percentage note and no client-scored index card', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    expect(container!.querySelector('.delta')).toBeNull()
    expect(container!.querySelector('.insight-summary')).toBeNull()
    expect(container!.querySelector('.control-row-note')).toBeNull()
    expect(container!.querySelector('.recovery-index-contributions')).toBeNull()
    expect(cardFor('Recovery index')).toBeUndefined()
  })
})

describe('the Recovery page: the hero', () => {
  it('leads with the index against the usual for a month, the day counts and what stood out', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    const hero = cardFor(HERO)!
    expect(hero.querySelector('.detail-hero-value')?.textContent).toBe('35')
    expect(hero.querySelector('.detail-verdict')?.textContent).toBe('below your usual 48 – 51 for a month, last 12 months')
    expect(hero.querySelector('.detail-verdict')?.className).toBe('detail-verdict worse')
    expect(heroLines()).toEqual([
      '6 of 29 days usual · 7 higher · 16 lower',
      'highest: 82 on Mon, Aug 3 ✦',
      'lowest: 0 on Tue, Aug 18',
      '-16 against July',
      'mostly down to your HRV',
    ])
    expect(heroBold()).toEqual(['82', '0', '-16', 'HRV'])
    expect(hero.querySelector('.period-hero-captions')?.textContent).toBe('every day this monthtap a day for its score and inputs')
  })

  it('says the same lines in Dutch', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH, 'nl')
    const hero = cardFor(HERO_NL)!
    expect(hero.querySelector('.detail-verdict')?.textContent).toBe('onder je gebruikelijke bereik 48 – 51 voor een maand, afgelopen 12 maanden')
    expect(heroLines(HERO_NL)).toEqual([
      '6 van 29 dagen gebruikelijk · 7 hoger · 16 lager',
      'je hoogste: 82 op ma 3 aug ✦',
      'je laagste: 0 op di 18 aug',
      '-16 tegenover juli',
      'vooral door je HRV',
    ])
    expect(hero.querySelector('.period-hero-captions')?.textContent).toBe('elke dag deze maandtik op een dag voor de score en de onderdelen')
  })

  it('names the input that carried the period, and says nothing when the server named none', async () => {
    await renderAt(MONTH_URL, month({ carriedBy: 'restingHeartRate' }))
    expect(heroLines().at(-1)).toBe('mostly down to your resting heart rate')
    await renderAt(MONTH_URL, month({ carriedBy: 'restingHeartRate' }), 'nl')
    expect(heroLines(HERO_NL).at(-1)).toBe('vooral door je rusthartslag')
    await renderAt(MONTH_URL, month({ carriedBy: null }))
    expect(heroLines()).toEqual([
      '6 of 29 days usual · 7 higher · 16 lower', 'highest: 82 on Mon, Aug 3 ✦', 'lowest: 0 on Tue, Aug 18', '-16 against July',
    ])
  })

  it('says the change against last year with the comparison on, once on a year where both name the same year', async () => {
    await renderAt(`${MONTH_URL}&compare=year`, RECOVERY_PERIOD_MONTH)
    expect(heroLines().slice(3)).toEqual(['-16 against July', '-16 against last year', 'mostly down to your HRV'])
    await renderAt(`${YEAR_URL}&compare=year`, JUDGED_YEAR)
    expect(cardFor(HERO)!.querySelector('.detail-verdict')?.textContent).toBe('within your usual 47 – 52 for a year, from 2024')
    expect(heroLines()).toEqual([
      '100 of 295 days usual · 97 higher · 98 lower',
      'highest: 74 on Fri, Mar 28 ✦',
      'lowest: 24 on Wed, May 7',
      '+2 against 2024',
      'mostly down to your breathing',
    ])
  })

  it('says why a thin usual judges nothing', async () => {
    await renderAt(YEAR_URL, RECOVERY_PERIOD_YEAR)
    expect(cardFor(HERO)!.querySelector('.detail-verdict')?.textContent).toBe('not enough history for a usual yet')
  })

  it('draws weekly points on a year, and says so', async () => {
    await renderAt(YEAR_URL, RECOVERY_PERIOD_YEAR)
    expect(sparklines.get(HERO)!.values).toHaveLength(RECOVERY_PERIOD_YEAR.hero.weekly!.length)
    expect(cardFor(HERO)!.querySelector('.period-hero-captions')?.textContent).toBe('every week, as its averagetap a week for its average')
  })

  it('says the index is read from all sources only once a source is chosen, in both languages', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    expect(sourceCaption()).toBeNull()
    await renderAt(`${MONTH_URL}&source=watch`, RECOVERY_PERIOD_MONTH)
    expect(sourceCaption())
      .toBe('the recovery index and HRV against its usual week are worked out from all sources, whichever source is chosen')
    await renderAt(`${MONTH_URL}&source=watch`, RECOVERY_PERIOD_MONTH, 'nl')
    expect(sourceCaption(HERO_NL))
      .toBe('de herstelindex en HRV tegenover je gebruikelijke week worden uit alle bronnen berekend, welke bron je ook kiest')
  })

  // The caption speaks for the HRV stretch too, so a hero with no value (no index scored) keeps it.
  it('keeps the source caption when the hero has no value to draw', async () => {
    const empty = month({ hero: { ...RECOVERY_PERIOD_MONTH.hero, value: null } })
    await renderAt(`${MONTH_URL}&source=watch`, empty)
    expect(cardFor(HERO)).toBeUndefined()
    const captions = [...container!.querySelectorAll('section.card > .dash-caption')].map((caption) => caption.textContent)
    expect(captions).toContain('the recovery index and HRV against its usual week are worked out from all sources, whichever source is chosen')
    await renderAt(MONTH_URL, empty)
    expect([...container!.querySelectorAll('section.card > .dash-caption')].map((caption) => caption.textContent))
      .not.toContain('the recovery index and HRV against its usual week are worked out from all sources, whichever source is chosen')
  })
})

describe('the Recovery page: the tap panel', () => {
  it('opens a day with its score and band, its inputs largest first, the day on the dashboard and a note or event on the day', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    act(() => { sparklines.get(HERO)!.onPointClick!('2026-08-01') })
    const panel = container!.querySelector('.point-panel')!
    expect(panel.querySelector('.point-panel-title')?.textContent).toBe('Saturday, August 1')
    const rows = [...panel.querySelectorAll('.point-panel-row')].map((row) =>
      [...row.querySelectorAll('dt, dd')].map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['Recovery index', '71', 'above your usual'],
      ['HRV', '+21 points'],
      ['Resting heart rate', '0 points'],
      ['Breathing rate', '0 points'],
      ['Last week\'s sleep', '0 points'],
    ])
    expect(panel.querySelector('.point-panel-verdict')?.className).toBe('point-panel-verdict better')
    expect(panel.querySelector('a.card-link')?.getAttribute('href')).toBe('/?day=2026-08-01')
    expect(panel.querySelector('a.card-link')?.textContent).toBe('View day')
    const annotate = panel.querySelector<HTMLButtonElement>('.point-panel-actions .button')!
    expect(annotate.textContent).toBe('Add a note or an event')
    act(() => { annotate.click() })
    expect(container!.querySelector('.point-panel')).toBeNull()
    // The day itself, never one of the index's inputs: the index is worked out, so there is no
    // reading to exclude, and an exclusion of HRV from here would remove HRV everywhere.
    const dialog = document.querySelector('.annotate-panel')!
    expect(dialog.querySelector('h2')?.textContent).toBe('This day, 2026-08-01')
    expect([...dialog.querySelectorAll('.segment')].map((segment) => segment.textContent)).toEqual(['Add a note', 'Add an event'])
    expect(dialog.querySelector('.segment[aria-pressed="true"]')?.textContent).toBe('Add a note')
  })

  // HRV by the name the figure row and the stretch give it, and the band in lower case like every
  // other verdict on the page, in Dutch too.
  it('says the same day panel in Dutch, HRV by its short name', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH, 'nl')
    act(() => { sparklines.get(HERO_NL)!.onPointClick!('2026-08-01') })
    const rows = [...container!.querySelectorAll('.point-panel .point-panel-row')].map((row) =>
      [...row.querySelectorAll('dt, dd')].map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['Herstelindex', '71', 'boven gebruikelijk'],
      ['HRV', '+21 punten'],
      ['Rusthartslag', '0 punten'],
      ['Ademhalingsfrequentie', '0 punten'],
      ['Afgelopen week aan slaap', '0 punten'],
    ])
  })

  // A week's dot is toned by its own verdict, against the usual for a week; the index's daily bands
  // would word it otherwise (44 is inside the daily usual band), so the panel says what the dot says.
  it('opens a week on a year with its average and its own verdict, as its dot shows it, and nowhere to go', async () => {
    await renderAt(YEAR_URL, RECOVERY_PERIOD_YEAR)
    const week = RECOVERY_PERIOD_YEAR.hero.weekly!.find((point) => point.from === '2025-07-07')!
    expect([week.value, week.standing, week.judged, bandOf(week.value!)]).toEqual([44, 'below', 'worse', 'usual'])
    act(() => { sparklines.get(HERO)!.onPointClick!(week.from) })
    const panel = container!.querySelector('.point-panel')!
    const rows = [...panel.querySelectorAll('.point-panel-row')].map((row) =>
      [...row.querySelectorAll('dt, dd')].map((cell) => cell.textContent))
    expect(rows).toEqual([['Recovery index', '44', 'below your usual']])
    expect(panel.querySelector('.point-panel-verdict')?.className).toBe('point-panel-verdict worse')
    expect(panel.querySelector('a.card-link')).toBeNull()
    expect(panel.querySelector('.point-panel-actions')).toBeNull()
  })
})

describe('the Recovery page: the figures and the heart rate', () => {
  it('lists resting heart rate, HRV and breathing rate, each with its day counts, under one caption', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    const minis = container!.querySelector('.detail-minis')!
    expect([...minis.querySelectorAll('.figure-row-label')].map((label) => label.textContent))
      .toEqual(['Resting heart rate', 'HRV', 'Breathing rate'])
    const hrv = [...minis.querySelectorAll('.figure-row')][1]!
    expect(hrv.querySelector('.figure-row-note')?.textContent).toBe('12 of 29 days usual · 3 higher · 14 lower')
    expect(minis.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every day this month · band = your usual range')
  })

  it('says the figures\' lines are weekly on a year, in both languages', async () => {
    await renderAt(YEAR_URL, RECOVERY_PERIOD_YEAR)
    expect(container!.querySelector('.detail-minis')!.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('each line: every week, the average of its days · band = your usual range')
    await renderAt(YEAR_URL, RECOVERY_PERIOD_YEAR, 'nl')
    expect(container!.querySelector('.detail-minis')!.parentElement!.querySelector(':scope > .dash-caption')?.textContent)
      .toBe('elk lijntje: elke week, het gemiddelde van haar dagen · band = je gebruikelijke bereik')
  })

  // The index is worked out from these readings, so a bad one is dropped by excluding it here:
  // a daily dot opens its own metric's day panel, the old metric cards' exclude restored.
  it("opens a figure row's day on its own metric, exclude first, on a month", async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    act(() => { sparklines.get('HRV')!.onPointClick!('2026-08-03') })
    const dialog = document.querySelector('.annotate-panel')!
    expect(dialog.querySelector('h2')?.textContent).toBe('daily_hrv on 2026-08-03')
    expect([...dialog.querySelectorAll('.segment')].map((segment) => segment.textContent))
      .toEqual(['Exclude', 'Add a note', 'Add an event'])
    expect(dialog.querySelector('.segment[aria-pressed="true"]')?.textContent).toBe('Exclude')
  })

  it("offers no tap on a figure row's weekly dots on a year", async () => {
    await renderAt(YEAR_URL, RECOVERY_PERIOD_YEAR)
    expect(['Resting heart rate', 'HRV', 'Breathing rate'].map((label) => sparklines.get(label)?.onPointClick))
      .toEqual([undefined, undefined, undefined])
    expect(sparklines.get('HRV')!.values.length).toBeGreaterThan(0)
  })

  it('leaves out the figures card when no figure has a value', async () => {
    await renderAt(MONTH_URL, month({ figures: RECOVERY_PERIOD_MONTH.figures.map((figure) => ({ ...figure, value: null })) }))
    expect(container!.querySelector('.detail-minis')).toBeNull()
    expect(cardFor(HERO)).toBeDefined()
  })

  it('draws the heart rate range across the whole row, after the figures', async () => {
    await renderAt(MONTH_URL, RECOVERY_PERIOD_MONTH)
    const cards = [...container!.querySelectorAll<HTMLElement>('section.card')]
    const heart = cardFor('Heart rate range')!
    expect(heart.dataset.span).toBe('12')
    expect(cards.indexOf(heart)).toBeGreaterThan(cards.indexOf(container!.querySelector<HTMLElement>('.detail-minis')!.closest('section.card')!))
  })
})
