// @vitest-environment happy-dom
//
// happy-dom because the page's arrows are buttons that navigate on click, and the only way to see
// where one goes is to press it and read the URL it left behind.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import { workoutPageKey } from '../src/data/useWorkoutPage.js'
import type { WorkoutPageData } from '../src/data/useWorkoutPage.js'
import type { WorkoutSessionDetail } from '../src/data/useSessions.js'
import * as echarts from 'echarts'
import { CHART_VARS, readChartTokens } from '../src/charts/tokens.js'
import { SESSION_ZONE_KEYS, ZONE_TOKENS } from '../src/charts/ZoneBar.js'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { navigate } from '../src/router.js'
import { pumpUntil } from './flush.js'
import {
  NAV_PREVIOUS_ID, NEXT_ID, PREVIOUS_ID, ROUTE_FIXTURE, SPLITS_FIXTURE, WORKOUT_ID,
  strengthPageFixture, strengthSessionFixture, workoutPageFixture, workoutSessionFixture,
} from './fixtures/workoutPage.js'
import type { IntradayPoint } from '../src/data/useIntraday.js'
import { pausesOf } from '../src/pages/activity/workout/workoutText.js'

// happy-dom applies no stylesheet, so the page's charts throw "missing chart token" without this.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Sets custom properties for one test and hands back what undoes it: each property restored to
 * the value it had before (the file-level stub's, when it set one), or removed when it had none,
 * so a later test never inherits a value this one invented.
 */
function overrideVars(values: Record<string, string>): () => void {
  const style = document.documentElement.style
  const before = Object.keys(values).map((variable) => [variable, style.getPropertyValue(variable)] as const)
  for (const [variable, value] of Object.entries(values)) style.setProperty(variable, value)
  return () => {
    for (const [variable, value] of before) {
      if (value === '') style.removeProperty(variable)
      else style.setProperty(variable, value)
    }
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let restoreFetch: (() => void) | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', `/activity/${WORKOUT_ID}`)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  restoreFetch?.()
  restoreFetch = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 450, sleepUseBaseline: false, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

type Answer = { status: number, body: unknown }
const NO_SUCH_WORKOUT: Answer = { status: 404, body: { error: { code: 'not_found', reason: 'no_such_workout', message: 'no workout' } } }

/**
 * Everything the page asks for beyond what the cache is seeded with: the old sections still below
 * the new ones (the trace's intraday window), answering empty, and the workout page itself
 * answering `page`, which only the cases that seed nothing ever reach.
 */
let tracePoints: IntradayPoint[] = []
// Every URL the page asked for, in order.
let fetched: string[] = []

function stubFetch(page: Answer): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    fetched.push(url)
    if (url.includes('/workout/')) return json(page.body, page.status)
    // An unseeded session read fails the way the page read is told to.
    if (url.includes(`/sessions/${WORKOUT_ID}`)) return json(page.body, page.status)
    if (url.includes('/intraday/window')) return json({ points: tracePoints, reduction: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({ items: [], cursor: null })
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original; tracePoints = []; fetched = [] }
}

async function mount(
  page: WorkoutPageData | null, session: WorkoutSessionDetail = workoutSessionFixture(),
  lng: 'en' | 'nl' = 'en', answer: Answer = NO_SUCH_WORKOUT, seedSession = true,
): Promise<HTMLDivElement> {
  stubFetch(answer)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  if (seedSession) client.setQueryData(queryKeys.resource('p1', 'session', { sessionId: WORKOUT_ID }), session)
  if (page !== null) client.setQueryData(workoutPageKey('p1', WORKOUT_ID), page)
  act(() => {
    root!.render(<I18nProvider lng={lng}><QueryClientProvider client={client}><WorkoutDetail /></QueryClientProvider></I18nProvider>)
  })
  await pumpUntil(() => !container!.innerHTML.includes('>Loading<') && !container!.innerHTML.includes('>Laden<'), 'the workout page to leave its loading state')
  await pumpUntil(() => client.isFetching() + client.isMutating() === 0, 'the page to have nothing left in flight')
  return container!
}

const text = (host: ParentNode, selector: string) => host.querySelector(selector)?.textContent
const button = (host: ParentNode, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

// Each mini row as [label, value, verdict], cell by cell, so a value that changed format fails on
// its own cell rather than hiding inside a run of text.
function minis(host: ParentNode): string[][] {
  return [...host.querySelectorAll('.detail-minis .figure-row')].map((row) => [
    text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '', text(row, '.figure-row-verdict') ?? '',
  ])
}

// How many sessions of a strip carry a shaded usual band: Sparkline's per-point band series.
function bandCount(chart: HTMLDivElement): number {
  const option = echarts.getInstanceByDom(chart)?.getOption() as { series: { type: string, data?: unknown[] }[] }
  return option.series.find((s) => s.type === 'custom')?.data?.length ?? 0
}

// The comparison table, one array of cell texts per body row.
function compared(host: ParentNode): string[][] {
  return [...host.querySelectorAll('.workout-compared tbody tr')].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''))
}

describe('the workout page\'s top', () => {
  // The dashboard's own header (PageHeader), as the night page's: the title, then when and who on
  // one line, and nothing else - the note and the name live in cards.
  it('is the shared header, titled with the exercise type, saying when it ran and who recorded it', async () => {
    const host = await mount(workoutPageFixture())
    expect(host.firstElementChild?.className).toBe('detail-page')
    expect(text(host, '.detail-page > .dash-header h1.dash-title')).toBe('Running')
    expect(text(host, '.dash-header .dash-date')).toBe('Friday, September 4, 18:00–18:34 · watch')
    expect(host.querySelector('.dash-header')!.textContent).not.toContain('Easy start')
  })

  it('quotes the workout\'s note in the day block, beside the day\'s own words', async () => {
    const card = cardLabelled(await mount(workoutPageFixture()), 'That day')!
    expect([...card.querySelectorAll('.day-log-note')].map((note) => note.textContent)).toEqual(['“Easy start, pushed the last kilometre.”'])
  })

  it('names the workout in the About line only when the name says something the type does not', async () => {
    // The fixture's displayName is "Running", the type's own label: said once, not twice.
    expect(text(cardLabelled(await mount(workoutPageFixture()), 'About this workout')!, '.detail-about-line'))
      .toBe('Recorded by watch · exclude or add a note')
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const session = workoutSessionFixture()
    const named = { ...session, attrs: { ...(session.attrs as object), displayName: 'Morning run' } }
    const host = await mount(workoutPageFixture(), named)
    expect(text(cardLabelled(host, 'About this workout')!, '.detail-about-line'))
      .toBe('Recorded by watch · named “Morning run” · exclude or add a note')
    expect(host.querySelector('.dash-header')!.textContent).not.toContain('Morning run')
  })

  it('says nothing about a note the workout does not have', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(host.textContent).not.toContain('Easy start')
  })

  it('steps to the neighbouring workouts the payload names, of any type', async () => {
    const host = await mount(workoutPageFixture())
    act(() => { button(host, 'Previous workout')!.click() })
    expect(window.location.pathname).toBe(`/activity/${NAV_PREVIOUS_ID}`)
    act(() => { navigate(`/activity/${WORKOUT_ID}`) })
    act(() => { button(host, 'Next workout')!.click() })
    expect(window.location.pathname).toBe(`/activity/${NEXT_ID}`)
  })

  it('leaves the arrow keys to the map when they are pressed on it', async () => {
    const host = await mount(workoutPageFixture(), fullSession())
    // MapLibre never loads under happy-dom (the SVG drawing stands in), so a stand-in for its
    // container: the live map pans on the arrow keys, which must not also step to another workout.
    const map = document.createElement('div')
    map.className = 'workout-route-map'
    host.querySelector('.workout-map')!.append(map)
    act(() => { map.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(window.location.pathname).toBe(`/activity/${WORKOUT_ID}`)
  })

  it('disables the arrow with no workout behind it', async () => {
    const host = await mount({ ...workoutPageFixture(), nav: { previous: NAV_PREVIOUS_ID, next: null } })
    expect(button(host, 'Next workout')!.disabled).toBe(true)
    expect(button(host, 'Previous workout')!.disabled).toBe(false)
  })

  it('links back to every workout with the header row\'s button, no arrow glyph', async () => {
    const host = await mount(workoutPageFixture())
    const link = host.querySelector<HTMLAnchorElement>('.dash-header .day-nav a.button.day-nav-back')
    expect(link?.textContent).toBe('All workouts')
    expect(link?.getAttribute('href')).toBe('/activity')
  })
})

describe('the workout page\'s hero', () => {
  it('leads with the pace, where it sits against the usual, and how it ranks among recent runs', async () => {
    const host = await mount(workoutPageFixture())
    expect(host.querySelector('.detail-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Pace')
    expect(text(host, '.detail-hero-value')).toBe('5:24\u00a0/km')
    expect(text(host, '.detail-hero .detail-verdict')).toBe('within your usual 5:22 – 5:36\u00a0/km')
    expect(host.querySelector('.detail-hero .detail-verdict')?.className).toBe('detail-verdict')
    expect(text(host, '.workout-hero-rank')).toBe('Faster than 17 of your last 20 of this type')
    expect(text(host, '.detail-hero .dash-caption')).toBe('this workout and the nine of this type before it · higher = faster')
    expect(host.querySelector('.detail-hero [role="img"][aria-label="Pace"]')).not.toBeNull()
  })

  // verdictTone, as the night's hero: better or worse on a judged figure, outside the usual on one
  // judged neither way.
  it('colours its verdict the way every other verdict on the page is coloured', async () => {
    const page = workoutPageFixture()
    const faster = { ...page.figures.pace!, value: 300, standing: 'below' as const, judged: 'better' as const }
    const fast = await mount({ ...page, figures: { ...page.figures, pace: faster } })
    expect(fast.querySelector('.detail-hero .detail-verdict')?.className).toBe('detail-verdict better')
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const strength = strengthPageFixture()
    const long = { ...strength.figures.movingTime!, baseline: { center: 2000, low: 1800, high: 2200, thin: false }, standing: 'above' as const, judged: null }
    const host = await mount({ ...strength, figures: { ...strength.figures, movingTime: long } }, strengthSessionFixture())
    expect(host.querySelector('.detail-hero .detail-verdict')?.className).toBe('detail-verdict is-out')
  })

  it('draws no rank beside a thin usual, or when the server says why there is nothing to compare', async () => {
    const page = workoutPageFixture()
    const pace = { ...page.figures.pace!, baseline: { ...page.figures.pace!.baseline!, thin: true }, standing: null, judged: null }
    const thin = await mount({ ...page, figures: { ...page.figures, pace } })
    expect(thin.querySelector('.workout-hero-rank')).toBeNull()
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const few = await mount({ ...page, comparison: { ...page.comparison, reason: 'too-few' } })
    expect(few.querySelector('.workout-hero-rank')).toBeNull()
  })

  it('turns a pace strip upside down, so a faster run sits higher, and leaves a speed strip the right way up', async () => {
    const yInverse = (h: ParentNode) => {
      const option = echarts.getInstanceByDom(h.querySelector<HTMLDivElement>('.detail-hero [role="img"]')!)?.getOption() as { yAxis: { inverse?: boolean }[] }
      return option.yAxis[0]!.inverse === true
    }
    const paceHost = await mount(workoutPageFixture())
    expect(yInverse(paceHost)).toBe(true)
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const page = workoutPageFixture()
    const speed = { ...page.figures.pace!, key: 'speed' as const, metric: 'speed', unit: 'meters_per_second', precision: 1, direction: 'up' as const,
      value: 3.1, baseline: null, standing: null, judged: null,
      strip: page.figures.pace!.strip.map((point) => ({ ...point, value: point.value === null ? null : 1000 / point.value })) }
    const speedHost = await mount({ ...page, hero: 'speed', figures: { ...page.figures, speed } })
    expect(yInverse(speedHost)).toBe(false)
    expect(text(speedHost, '.detail-hero .dash-caption')).toBe('this workout and the nine of this type before it')
  })

  it('says how it compares with the previous one of this type, and links to it', async () => {
    const host = await mount(workoutPageFixture())
    expect(text(host, '.workout-hero-previous')).toBe('12 s/km faster than the previous one, Tuesday, September 1')
    const link = host.querySelector<HTMLAnchorElement>('.detail-hero a.card-link')
    expect(link?.textContent).toBe('View the previous one')
    expect(link?.getAttribute('href')).toBe(`/activity/${PREVIOUS_ID}`)
  })

  it('says slower, not a negative faster, when the pace was slower', async () => {
    const page = workoutPageFixture()
    const host = await mount({ ...page, previous: { ...page.previous!, values: { ...page.previous!.values, pace: 318 } } })
    expect(text(host, '.workout-hero-previous')).toBe('6 s/km slower than the previous one, Tuesday, September 1')
  })

  it('names the Records best for this type as "your best"', async () => {
    const host = await mount(workoutPageFixture())
    expect(text(host, '.workout-hero-best')).toBe('Your best: fastest kilometre 4:50\u00a0/km (June)')
  })

  // Records' longest is start to finish: beside an elapsed hero it is the same measure, beside a
  // moving-time hero it set elapsed against moving as if one could beat the other.
  it('names the longest only under an elapsed-time hero, never under a moving-time one', async () => {
    const strength = strengthPageFixture()
    const best = { ...strength.best, longestMs: { value: 3_235_000, sessionId: 'long', localDate: '2026-03-10' } }
    const moving = await mount({ ...strength, best }, strengthSessionFixture())
    expect(moving.querySelector('.workout-hero-best')).toBeNull()
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const { movingTime: _m, ...figures } = strength.figures
    const elapsed = await mount({ ...strength, best, hero: 'elapsed', figures }, strengthSessionFixture())
    expect(text(elapsed, '.workout-hero-best')).toBe('Your best: longest 53:55 (March)')
  })

  it('leads with moving time for a strength session, with no ranking, no previous one and no best', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(host.querySelector('.detail-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Moving time')
    expect(text(host, '.detail-hero-value')).toBe('45:00')
    expect(text(host, '.detail-hero .detail-verdict')).toBe('not enough history for a usual yet')
    expect(host.querySelector('.workout-hero-rank')).toBeNull()
    expect(host.querySelector('.workout-hero-previous')).toBeNull()
    expect(host.querySelector('.workout-hero-best')).toBeNull()
    // One session is one dot, which joins nothing.
    expect(host.querySelector('.detail-hero [role="img"]')).toBeNull()
  })

  it('shades the hero strip with the figure\'s usual band, and draws none for a thin one', async () => {
    const page = workoutPageFixture()
    const bandedHost = await mount(page)
    expect(bandCount(bandedHost.querySelector<HTMLDivElement>('.detail-hero [role="img"]')!)).toBe(10)
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const pace = { ...page.figures.pace!, baseline: { ...page.figures.pace!.baseline!, thin: true }, standing: null, judged: null }
    const thinHost = await mount({ ...page, figures: { ...page.figures, pace } })
    expect(bandCount(thinHost.querySelector<HTMLDivElement>('.detail-hero [role="img"]')!)).toBe(0)
  })
})

describe('the workout page\'s four figures', () => {
  it('are distance, moving time, average heart rate and cardio load, each with its verdict and strip', async () => {
    const host = await mount(workoutPageFixture())
    expect(minis(host)).toEqual([
      ['Distance', '5.20\u00a0km', 'within your usual 4.60 – 5.60\u00a0km'],
      ['Moving time', '28:04', 'within your usual 25:00 – 31:00'],
      ['Avg heart rate', '157\u00a0bpm', 'within your usual 150 – 158\u00a0bpm'],
      ['Cardio load', '71', 'above your usual 55 – 70'],
    ])
    expect(host.querySelectorAll('.detail-minis [role="img"]')).toHaveLength(4)
    expect(host.querySelector('.detail-minis .detail-rows')?.getAttribute('data-columns')).toBe('4')
    // Cardio load sits above its usual on a figure judged neither way: its words take the tone.
    expect(host.querySelectorAll('.detail-minis .figure-row-verdict')[3]?.className).toBe('figure-row-verdict is-out')
    expect(text(host, '.detail-minis .dash-caption')).toBe('each line: this workout and the nine of this type before it · band = your usual range')
  })

  it('leave out a figure the workout has no reading for, and the one the hero already leads with', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(minis(host).map(([label]) => label)).toEqual(['Avg heart rate'])
    // One figure takes the card rather than a quarter of it.
    expect(host.querySelector('.detail-minis .detail-rows')?.getAttribute('data-columns')).toBe('1')
  })

  it('colour each strip dot by where the server said that session stood', async () => {
    const restore = overrideVars({ '--negative': '#ff0000' })
    try {
      const host = await mount(workoutPageFixture())
      // Cardio load's latest session (71) is above its usual 55-70; the first (58) inside it.
      const chart = host.querySelector<HTMLDivElement>('.detail-minis [role="img"][aria-label="Cardio load"]')!
      const option = echarts.getInstanceByDom(chart)?.getOption() as { series: { data: ({ itemStyle?: { color?: string } } | null)[] }[] }
      const dots = option.series.find((s) => Array.isArray(s.data) && s.data.some((d) => d !== null && typeof d === 'object' && 'itemStyle' in d))!
      expect(dots.data.at(-1)?.itemStyle?.color).toBe('#ff0000')
      expect(dots.data[0]?.itemStyle?.color).not.toBe('#ff0000')
    } finally { restore() }
  })

  it('leave out the whole card when none of the four has a reading', async () => {
    const page = workoutPageFixture()
    const { distance: _d, movingTime: _m, averageHeartRate: _a, cardioLoad: _c, ...rest } = page.figures
    const host = await mount({ ...page, figures: rest })
    expect(host.querySelector('.detail-minis')).toBeNull()
  })
})

describe('the workout page\'s compared-with table', () => {
  it('sets this workout beside the previous one, the usual and the best, row by row', async () => {
    const host = await mount(workoutPageFixture())
    expect([...host.querySelectorAll('.workout-compared thead th')].map((th) => th.textContent)).toEqual([
      'Measure', 'This workout', 'Previous · Sep 1', 'Usual', 'Your best',
    ])
    // The corner cell is named for a screen reader, and the table says what it holds.
    expect(host.querySelector('.workout-compared thead th .sr-only')?.textContent).toBe('Measure')
    expect(host.querySelector('.workout-compared caption.sr-only')?.textContent).toBe('This workout beside the previous one of its type, the usual range and your best')
    expect(compared(host)).toEqual([
      ['Pace', '5:24\u00a0/km', '5:36\u00a0/km -12 s', '5:22 – 5:36\u00a0/km', '4:50\u00a0/km · June'],
      ['Distance', '5.20\u00a0km', '5.00\u00a0km +0.20', '4.60 – 5.60\u00a0km', '10.40\u00a0km · May'],
      ['Avg heart rate', '157\u00a0bpm', '153\u00a0bpm +4', '150 – 158\u00a0bpm', '—'],
      ['Cardio load', '71', '62 +9', '55 – 70', '—'],
    ])
    expect(host.querySelector('.workout-compared thead a.card-link')?.getAttribute('href')).toBe(`/activity/${PREVIOUS_ID}`)
  })

  // A ride leads with its speed, so its table's first row is speed, with the previous ride's own.
  it('follows a speed hero with a speed row, its difference in km/h', async () => {
    const page = workoutPageFixture()
    const speed = { ...page.figures.pace!, key: 'speed' as const, metric: 'speed', unit: 'meters_per_second', precision: 2, direction: 'up' as const,
      value: 7.5, baseline: { center: 7, low: 6.5, high: 7.5, thin: false }, standing: 'within' as const, judged: null }
    const { pace: _p, ...rest } = page.figures
    const host = await mount({
      ...page, exerciseType: 'BIKING', hero: 'speed', figures: { ...rest, speed },
      previous: { ...page.previous!, values: { speed: 7, distance: 5000, averageHeartRate: 153, cardioLoad: 62 } },
    })
    expect(compared(host)[0]).toEqual(['Speed', '27.0\u00a0km/h', '25.2\u00a0km/h +1.8', '23.4 – 27.0\u00a0km/h', '—'])
  })

  it('leaves every difference from the previous one the plain colour', async () => {
    const host = await mount(workoutPageFixture())
    const diffs = [...host.querySelectorAll('.workout-compared .workout-diff')].map((span) => span.className)
    // One faster run says nothing about a trend, so no difference is judged better or worse.
    expect(diffs).toEqual(['workout-diff', 'workout-diff', 'workout-diff', 'workout-diff'])
    const css = readFileSync('apps/web/src/app.css', 'utf8')
    expect(css).not.toMatch(/\.workout-diff\.(better|worse)/)
  })

  // No silent sideways scroll on a phone: the best and the usual columns go, and the rest fits.
  it('drops the best and the usual columns on a phone', async () => {
    const host = await mount(workoutPageFixture())
    expect(host.querySelectorAll('.workout-compared .workout-compared-best')).toHaveLength(5)
    expect(host.querySelectorAll('.workout-compared .workout-compared-usual')).toHaveLength(5)
    const css = readFileSync('apps/web/src/app.css', 'utf8')
    expect(css).toMatch(/@media \(max-width: 620px\) \{[^}]*\.workout-compared-best, \.workout-compared-usual \{ display: none; \}/)
  })

  it('leaves out a row the workout has no value for, and the previous column when there is no previous one', async () => {
    const page = workoutPageFixture()
    const { pace: _p, ...rest } = page.figures
    const host = await mount({ ...page, figures: rest, previous: null })
    expect(compared(host).map((row) => row[0])).toEqual(['Distance', 'Avg heart rate', 'Cardio load'])
    expect([...host.querySelectorAll('.workout-compared thead th')].map((th) => th.textContent)).toEqual([
      'Measure', 'This workout', 'Usual', 'Your best',
    ])
  })

  it('is left out for a strength session, where there is nothing to set its figures beside', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(host.querySelector('.workout-compared')).toBeNull()
    // A short page: no pace anywhere on it.
    expect(host.textContent).not.toContain('/km')
  })
})

describe('the workout page in Dutch', () => {
  it('words the hero, its ranking and the previous one from the Dutch catalogue', async () => {
    const host = await mount(workoutPageFixture(), workoutSessionFixture(), 'nl')
    expect(host.querySelector('.detail-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Tempo')
    expect(text(host, '.workout-hero-rank')).toBe('Sneller dan 17 van je laatste 20 van dit type')
    expect(text(host, '.workout-hero-previous')).toBe('12 s/km sneller dan de vorige, dinsdag 1 september')
    expect(text(host, '.detail-hero a.card-link')).toBe('Bekijk de vorige')
    expect(text(host, '.workout-hero-best')).toBe('Je beste: snelste kilometer 4:50\u00a0/km (juni)')
    expect(text(host, '.detail-page h1')).toBe('Hardlopen')
    expect(text(host, '.day-nav-back')).toBe('Alle trainingen')
    expect(text(host, '.detail-minis .dash-caption')).toBe('elk lijntje: deze training en de negen van dit type ervoor · band = je gebruikelijke bereik')
    expect([...host.querySelectorAll('.workout-compared thead th')].map((th) => th.textContent)).toContain('Gebruikelijk')
    expect(host.querySelector('.workout-compared caption')?.textContent).toBe('Deze training naast de vorige van dit type, het gebruikelijke bereik en je beste')
  })
})

describe('the workout page without a workout', () => {
  // Never a dead end: the header stays, with a generic title, the arrows disabled and the way
  // back live, and the message sits in a card as every other state's does.
  it('says there is no such workout when the page read answers 404, under the header', async () => {
    const host = await mount(null)
    expect(text(host, '.detail-page > .grid > .card')).toContain('No such workout')
    expect(text(host, '.detail-page > .dash-header h1')).toBe('Workout')
    expect(button(host, 'Previous workout')!.disabled).toBe(true)
    expect(button(host, 'Next workout')!.disabled).toBe(true)
    expect(host.querySelector('.day-nav-back')?.getAttribute('href')).toBe('/activity')
  })

  it('offers a retry when the page read fails for any other reason, under the header', async () => {
    const host = await mount(null, workoutSessionFixture(), 'en', { status: 500, body: { error: { code: 'internal', message: 'boom' } } })
    expect(host.innerHTML).not.toContain('No such workout')
    expect(host.querySelector('.detail-page > .grid .card button')?.textContent).toBe('Try again')
    expect(text(host, '.detail-page > .dash-header h1')).toBe('Workout')
  })

  it('retries every read that failed, not only the first', async () => {
    const boom = { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
    const host = await mount(null, workoutSessionFixture(), 'en', boom, false)
    fetched = []
    act(() => { host.querySelector<HTMLButtonElement>('.grid .card button')!.click() })
    await pumpUntil(() => fetched.length >= 2, 'both reads to be asked for again')
    expect(fetched.some((url) => url.includes(`/sessions/${WORKOUT_ID}`))).toBe(true)
    expect(fetched.some((url) => url.includes('/workout/'))).toBe(true)
  })
})

// The session's start and end (the fixture's 18:00 to 18:34 in Amsterdam), for placing readings.
const START = workoutSessionFixture().startMs
const END = workoutSessionFixture().endMs
const minute = (n: number) => START + n * 60_000

/**
 * The fixture session with a route, the mockup's six splits, a pause and the four zones. The pause
 * is synthetic: a PAUSE twelve minutes in, resumed by a START, is the shape a mid-session pause
 * would take, but no archived session has one yet. Real sessions carry PAUSE only in the finish
 * sequence (`finishEvents` below), which draws no pause at all.
 */
function fullSession(): WorkoutSessionDetail {
  const session = workoutSessionFixture()
  return {
    ...session,
    route: ROUTE_FIXTURE,
    autoSplits: SPLITS_FIXTURE,
    attrs: {
      ...(session.attrs as Record<string, unknown>),
      metricsSummary: {
        caloriesKcal: 412, distanceMillimeters: 5_200_000,
        heartRateZoneDurations: { lightTime: '240s', moderateTime: '540s', vigorousTime: '720s', peakTime: '180s' },
      },
      exerciseEvents: [
        { eventTime: new Date(START).toISOString(), exerciseEventType: 'START' },
        { eventTime: new Date(minute(12)).toISOString(), exerciseEventType: 'PAUSE' },
        { eventTime: new Date(minute(13) + 40_000).toISOString(), exerciseEventType: 'START' },
        { eventTime: new Date(END).toISOString(), exerciseEventType: 'STOP' },
      ],
    },
  }
}

/** The two finish sequences archived sessions really carry: PAUSE a second before STOP at the end,
 *  and STOP at the end with PAUSE a second after it. */
const finishEvents = {
  pauseThenStop: [
    { eventTime: new Date(START).toISOString(), exerciseEventType: 'START' },
    { eventTime: new Date(END - 1000).toISOString(), exerciseEventType: 'PAUSE' },
    { eventTime: new Date(END).toISOString(), exerciseEventType: 'STOP' },
  ],
  stopThenPause: [
    { eventTime: new Date(START).toISOString(), exerciseEventType: 'START' },
    { eventTime: new Date(END).toISOString(), exerciseEventType: 'STOP' },
    { eventTime: new Date(END + 1000).toISOString(), exerciseEventType: 'PAUSE' },
  ],
}

const withEvents = (events: unknown[]): WorkoutSessionDetail => {
  const session = fullSession()
  return { ...session, attrs: { ...(session.attrs as Record<string, unknown>), exerciseEvents: events } }
}

const reading = (utcMs: number, mean: number, max = mean + 2): IntradayPoint =>
  ({ sourceId: 'watch', utcMs, min: mean - 2, mean, max, n: 1, excluded: false })

// The kilometre table, one array of cell texts per body row.
function kilometres(host: ParentNode): string[][] {
  return [...host.querySelectorAll('.workout-km tbody tr')].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''))
}

/** The option the chart inside `selector` was last given. */
function optionIn(host: ParentNode, selector: string) {
  return echarts.getInstanceByDom(host.querySelector<HTMLDivElement>(`${selector} [role="img"]`)!)!.getOption() as {
    xAxis: { type: string, min: number, max: number, interval: number }[]
    series: { id?: string, markArea?: { data: { name?: string, xAxis?: number, yAxis?: number }[][] } }[]
  }
}

describe('the workout page\'s route and kilometres', () => {
  it('draws the route with its height profile beside the kilometres, each with its pace, bar and heart rate', async () => {
    const host = await mount(workoutPageFixture(), fullSession())
    expect(host.querySelector('.workout-map .workout-route-svg')).not.toBeNull()
    expect(host.querySelector('.workout-elevation-line')?.getAttribute('points')).toBe('0,40 133.3,0 400,36')
    expect(text(host, '.workout-elevation-gain')).toBe('+42\u00a0m')
    expect(kilometres(host)).toEqual([
      ['1', '5:32', '', '146'], ['2', '5:24', '', '152'], ['3', '5:26', '', '156'],
      ['4', '5:15', '', '163'], ['5', '5:02', '', '171'], ['0.2', '4:51', '', '176†'],
    ])
    // The fastest kilometre fills its row, the slowest draws the floor.
    const widths = [...host.querySelectorAll<HTMLElement>('.workout-km-bar-fill')].map((bar) => bar.style.width)
    expect(widths[0]).toBe('40%')
    expect(widths[5]).toBe('100%')
    expect(host.querySelector('.workout-map .workout-splits-footnote')).not.toBeNull()
    expect(text(host, '.workout-split-trend')).toBe('Negative split · second half 22 s/km faster')
  })

  it('words a slower second half as a positive split, and a level one as even', async () => {
    const slower = await mount({ ...workoutPageFixture(), splitTrend: { secondHalfFasterBySecondsPerKm: -9 } }, fullSession())
    expect(text(slower, '.workout-split-trend')).toBe('Positive split · second half 9 s/km slower')
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const even = await mount({ ...workoutPageFixture(), splitTrend: { secondHalfFasterBySecondsPerKm: 0 } }, fullSession())
    expect(text(even, '.workout-split-trend')).toBe('Even split · both halves at the same pace')
  })

  it('draws the route alone without two kilometres, and the kilometres alone without a route', async () => {
    const routeOnly = await mount(workoutPageFixture(), { ...fullSession(), autoSplits: SPLITS_FIXTURE.slice(0, 1) })
    expect(routeOnly.querySelector('.workout-map .workout-route-svg')).not.toBeNull()
    expect(routeOnly.querySelector('.workout-km')).toBeNull()
    expect(routeOnly.querySelector('.workout-split-trend')).toBeNull()
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const kmOnly = await mount(workoutPageFixture(), { ...fullSession(), route: [] })
    expect(kmOnly.querySelector('.workout-route-svg')).toBeNull()
    expect(kilometres(kmOnly)).toHaveLength(6)
  })

  it('is left out with neither a route nor two kilometres', async () => {
    const host = await mount(workoutPageFixture(), { ...fullSession(), route: [], autoSplits: SPLITS_FIXTURE.slice(0, 1) })
    expect(host.querySelector('.workout-map')).toBeNull()
  })

  it('says nothing about the split without the server\'s trend', async () => {
    const host = await mount({ ...workoutPageFixture(), splitTrend: null }, fullSession())
    expect(kilometres(host)).toHaveLength(6)
    expect(host.querySelector('.workout-split-trend')).toBeNull()
  })

  // Moved from the old WorkoutRoute.tsx's own card test (workout-route-card.test.tsx), which
  // asserted this against WorkoutRoute directly before Task 5 of M10a-3 retired that card: the
  // count is still real behaviour of this card, now built by WorkoutMap.tsx from the session's own
  // route length rather than by the component this used to test.
  it('marks the start and numbers each whole kilometre on the route', async () => {
    const host = await mount(workoutPageFixture(), fullSession())
    const svg = host.querySelector('.workout-route-svg')!
    expect(svg.querySelectorAll('.workout-route-start')).toHaveLength(1)
    // Five whole kilometres; the last 200 m gets no number.
    expect([...svg.querySelectorAll('.workout-route-km text')].map((label) => label.textContent)).toEqual(['1', '2', '3', '4', '5'])
  })

  // The card's first line is its label, as on every other card; the basis is a caption under the map.
  it('states how many points the phone recorded under the map, after the route\'s label', async () => {
    const host = await mount(workoutPageFixture(), fullSession())
    const card = host.querySelector('.workout-map')!.closest('.card')!
    expect(card.querySelector('.basis')).toBeNull()
    const route = card.querySelector('.workout-map-route')!
    expect(route.firstElementChild?.textContent).toBe('Route')
    expect(text(route, '.workout-route-svg + .dash-caption, .dash-caption')).toBe(`every point the phone recorded, ${ROUTE_FIXTURE.length} in total`)
  })

  // Moved from the old WorkoutSplits.tsx's own tests (workout-splits.test.tsx), which asserted this
  // absent-vs-zero distinction against that component's table directly before Task 5 of M10a-3
  // retired it: the kilometre table (WorkoutMap.tsx's KilometreTable) reads pace and heart rate the
  // same defensive way, `=== null` rather than truthiness, so a recorded zero must not collapse
  // into the same absent marker as a field the split never recorded.
  it('leaves the pace and heart rate cells absent when a split recorded neither, without turning a real zero absent too', async () => {
    const mixed = [
      { ...SPLITS_FIXTURE[0]!, paceSecondsPerKm: null, averageHeartRateBpm: null, averageHeartRateBpmSource: null },
      { ...SPLITS_FIXTURE[1]!, averageHeartRateBpm: 0, averageHeartRateBpmSource: 'provider' as const },
    ]
    const host = await mount(workoutPageFixture(), { ...fullSession(), autoSplits: mixed })
    expect(kilometres(host)).toEqual([
      ['1', '—', '', '—'],
      ['2', '5:24', '', '0'],
    ])
  })
})

describe('the workout page\'s trace', () => {
  it('draws the heart rate on the workout\'s own clock, with its zones behind it and its pause shaded', async () => {
    tracePoints = [reading(minute(1), 120), reading(minute(10), 150), reading(minute(26) + 30_000, 175, 178), reading(minute(33), 160)]
    const host = await mount(workoutPageFixture(), fullSession())
    const card = host.querySelector('.workout-through')!.closest('.card')!
    expect(text(card, '.label')).toBe('Through the workout')
    expect(text(card, '.basis')).toBe('on the workout\'s own clock, 0:00 to 34:00 · one pause of 1:40')
    expect(text(host, '.workout-through-summary')).toBe('highest 178\u00a0bpm at 26:30')
    const option = optionIn(host, '.workout-through-chart')
    expect(option.xAxis[0]).toMatchObject({ type: 'value', min: 0, max: 34 * 60_000, interval: 5 * 60_000 })
    const zones = option.series.find((series) => series.id === 'zones')!
    expect(zones.markArea!.data.map(([from, to]) => [from!.name, from!.yAxis, to!.yAxis])).toEqual([
      ['Light', 110, 113], ['Moderate', 113, 137], ['Vigorous', 137, 162], ['Peak', 162, 187],
    ])
    const pause = option.series.find((series) => series.markArea?.data[0]?.[0]?.xAxis !== undefined)!
    expect(pause.markArea!.data).toEqual([[expect.objectContaining({ xAxis: 12 * 60_000 }), expect.objectContaining({ xAxis: 13 * 60_000 + 40_000 })]])
  })

  for (const [shape, events] of Object.entries(finishEvents)) {
    it(`reads the finish sequence (${shape}) as the end of the workout, not as a pause`, async () => {
      tracePoints = [reading(minute(10), 150), reading(minute(33), 160)]
      const host = await mount(workoutPageFixture(), withEvents(events))
      const card = host.querySelector('.workout-through')!.closest('.card')!
      expect(text(card, '.basis')).toBe("on the workout's own clock, 0:00 to 34:00")
      const option = echarts.getInstanceByDom(host.querySelector<HTMLDivElement>('.workout-through-chart [role="img"]')!)!
        .getOption() as { series: { markArea?: { data: { xAxis?: number }[][] }, markLine?: unknown }[] }
      expect(option.series.some((series) => series.markArea?.data[0]?.[0]?.xAxis !== undefined)).toBe(false)
      expect(option.series.some((series) => series.markLine !== undefined)).toBe(false)
    })
  }

  it('draws no zones when the server sent no bounds, and is left out with no heart rate at all', async () => {
    tracePoints = [reading(minute(10), 150)]
    const host = await mount({ ...workoutPageFixture(), zoneBounds: null }, fullSession())
    expect(optionIn(host, '.workout-through-chart').series.some((series) => series.id === 'zones')).toBe(false)
    act(() => { root!.unmount() })
    root = createRoot(container!)
    tracePoints = []
    const empty = await mount(workoutPageFixture(), fullSession())
    expect(empty.querySelector('.workout-through')).toBeNull()
  })
})

describe('the workout page\'s zones', () => {
  it('says how long was hard against the usual, beside one bar and a legend of each zone\'s minutes', async () => {
    const host = await mount(workoutPageFixture(), fullSession())
    const card = host.querySelector('.workout-zones')!.closest('.card')!
    expect(text(card, '.label')).toBe('Heart-rate zones')
    expect(text(host, '.workout-zones-verdict')).toBe('15\u00a0min hard or peak · above your usual 8 – 14\u00a0min')
    expect([...host.querySelectorAll('.workout-zones .detail-legend li')].map((li) => li.textContent)).toEqual([
      'Light 4\u00a0min', 'Moderate 9\u00a0min', 'Vigorous 12\u00a0min', 'Peak 3\u00a0min',
    ])
    expect([...host.querySelectorAll('.workout-zones .detail-legend-key')].map((key) => key.getAttribute('data-zone'))).toEqual(['light', 'moderate', 'vigorous', 'peak'])
  })

  it('draws the bar in the four zone colours, not the ramp', async () => {
    const restore = overrideVars({
      '--chart-zone-light': '#0000b0', '--chart-zone-moderate': '#0000b1', '--chart-zone-vigorous': '#0000b2', '--chart-zone-peak': '#0000b3',
    })
    try {
      const host = await mount(workoutPageFixture(), fullSession())
      const option = echarts.getInstanceByDom(host.querySelector<HTMLDivElement>('.workout-zones-bar [role="img"]')!)!
        .getOption() as { series: { itemStyle: { color: string } }[] }
      expect(option.series.map((series) => series.itemStyle.color)).toEqual(['#0000b0', '#0000b1', '#0000b2', '#0000b3'])
    } finally { restore() }
  })

  // The legend's swatches are CSS and the bar and the trace's bands are ZONE_TOKENS; this ties the
  // two, reading each token's custom property off readChartTokens itself (handed a style whose
  // every property "is" its own name), so a zone recoloured in one place fails here until the
  // other follows.
  it('keys the legend in the same zone colours the bar and the bands are drawn in', () => {
    const css = readFileSync('apps/web/src/app.css', 'utf8')
    const variableOf = readChartTokens({ getPropertyValue: (variable: string) => variable })
    for (const zone of SESSION_ZONE_KEYS) {
      expect(css).toContain(`.detail-legend-key[data-zone="${zone}"] { background: var(${variableOf[ZONE_TOKENS[zone]]}); }`)
    }
  })

  it('is left out when the session recorded no zones', async () => {
    const host = await mount(workoutPageFixture())
    expect(host.querySelector('.workout-zones')).toBeNull()
  })

  it('words the zones and the trace in Dutch', async () => {
    tracePoints = [reading(minute(10), 150), reading(minute(26) + 30_000, 175, 178)]
    const host = await mount(workoutPageFixture(), fullSession(), 'nl')
    expect(text(host, '.workout-zones-verdict')).toBe('15\u00a0min zwaar of piek · boven je gebruikelijke bereik 8 – 14\u00a0min')
    expect(text(host, '.workout-split-trend')).toBe('Negatieve split · tweede helft 22 s/km sneller')
    expect(host.querySelector('.workout-through')!.closest('.card')!.querySelector('.label')?.textContent).toBe('Door de training')
    // Elapsed time, not a clock time: "na" 26:30, never "om".
    expect(text(host, '.workout-through-summary')).toBe('hoogste 178\u00a0bpm na 26:30')
  })
})

describe('pausesOf', () => {
  const at = (ms: number, kind: string) => ({ atMs: ms, kind })
  const end = 34 * 60_000

  it('shades a pause the clock was started again after, by START, RESUME or AUTO_RESUME', () => {
    for (const resume of ['START', 'RESUME', 'AUTO_RESUME']) {
      expect(pausesOf([at(0, 'START'), at(600_000, 'PAUSE'), at(700_000, resume), at(end, 'STOP')], end))
        .toEqual({ spans: [{ startMs: 600_000, endMs: 700_000 }], marks: [] })
    }
  })

  it('draws nothing for the finish: a pause near the end, or one only a STOP closes', () => {
    expect(pausesOf([at(0, 'START'), at(end - 1000, 'PAUSE'), at(end, 'STOP')], end)).toEqual({ spans: [], marks: [] })
    expect(pausesOf([at(0, 'START'), at(end, 'STOP'), at(end + 1000, 'PAUSE')], end)).toEqual({ spans: [], marks: [] })
    expect(pausesOf([at(0, 'START'), at(end - 90_000, 'PAUSE'), at(end - 30_000, 'START')], end)).toEqual({ spans: [], marks: [] })
    // Mid-session, but closed by STOP: the person paused and then finished.
    expect(pausesOf([at(0, 'START'), at(600_000, 'PAUSE'), at(end, 'STOP')], end)).toEqual({ spans: [], marks: [] })
  })

  it('marks a mid-session pause nothing after it closes, drawing no span it would have to invent', () => {
    expect(pausesOf([at(0, 'START'), at(600_000, 'AUTO_PAUSE')], end)).toEqual({ spans: [], marks: [{ atMs: 600_000 }] })
  })
})

// The card whose own label reads `label`, or undefined when the page drew none.
const cardLabelled = (host: ParentNode, label: string) =>
  [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === label)

// Each figure row in `card` as [label, value, verdict], cell by cell (the minis' own reason).
function rowsIn(card: ParentNode): string[][] {
  return [...card.querySelectorAll('.figure-row')].map((row) => [
    text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '', text(row, '.figure-row-verdict') ?? '',
  ])
}

describe('the workout page\'s running form', () => {
  it('reads cadence, stride, ground contact in milliseconds, oscillation in centimetres and the ratio, each against its usual', async () => {
    const card = cardLabelled(await mount(workoutPageFixture()), 'Running form')!
    expect(text(card, '.detail-side-caption')).toBe('from your watch, runs only')
    expect(rowsIn(card)).toEqual([
      ['Cadence', '172\u00a0/min', 'within your usual 166 – 174\u00a0/min'],
      ['Stride length', '1.09\u00a0m', 'within your usual 1.02 – 1.10\u00a0m'],
      ['Ground contact', '248\u00a0ms', 'within your usual 240 – 262\u00a0ms'],
      ['Vertical oscillation', '8.9\u00a0cm', 'within your usual 8.4 – 9.6\u00a0cm'],
      ['Vertical ratio', '8.2\u00a0%', 'within your usual 7.9 – 8.9\u00a0%'],
    ])
  })

  it('is left out for a workout with no running form at all', async () => {
    expect(cardLabelled(await mount(strengthPageFixture(), strengthSessionFixture()), 'Running form')).toBeUndefined()
  })
})

describe('the workout page\'s more about this workout', () => {
  it('lists the rest of the figures, elapsed against moving with its pause, and VO2max with its strip', async () => {
    const card = cardLabelled(await mount(workoutPageFixture(), fullSession()), 'More about this workout')!
    expect(rowsIn(card)).toEqual([
      ['Calories', '412\u00a0kcal', 'within your usual 340 – 430\u00a0kcal'],
      ['Steps', '5,310', 'within your usual 4,700 – 5,600'],
      ['Highest heart rate', '178\u00a0bpm', 'no usual yet'],
      ['Active zone minutes', '43\u00a0min', 'within your usual 30 – 45\u00a0min'],
      ['Elevation gain', '42\u00a0m', 'within your usual 20 – 60\u00a0m'],
      ['Load (TRIMP)', '64', 'no usual yet'],
      ['Elapsed', '34:00', '28:04 moving · one pause'],
      ['VO₂max', '46', 'within your usual 44 – 46'],
    ])
    const rows = [...card.querySelectorAll('.figure-row')]
    // The trend is VO2max's alone: every other row here draws today's reading on its bar.
    expect(rows[7]!.querySelector('[role="img"]')).not.toBeNull()
    expect(rows.slice(0, 7).some((row) => row.querySelector('[role="img"]') !== null)).toBe(false)
  })

  it('says only the moving time when the workout never paused, and counts more than one', async () => {
    const plain = cardLabelled(await mount(workoutPageFixture()), 'More about this workout')!
    expect(rowsIn(plain).find(([label]) => label === 'Elapsed')?.[2]).toBe('28:04 moving')
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const twice = withEvents([
      { eventTime: new Date(START).toISOString(), exerciseEventType: 'START' },
      { eventTime: new Date(minute(5)).toISOString(), exerciseEventType: 'PAUSE' },
      { eventTime: new Date(minute(6)).toISOString(), exerciseEventType: 'RESUME' },
      { eventTime: new Date(minute(15)).toISOString(), exerciseEventType: 'AUTO_PAUSE' },
      { eventTime: new Date(minute(16)).toISOString(), exerciseEventType: 'AUTO_RESUME' },
      { eventTime: new Date(END).toISOString(), exerciseEventType: 'STOP' },
    ])
    const card = cardLabelled(await mount(workoutPageFixture(), twice), 'More about this workout')!
    expect(rowsIn(card).find(([label]) => label === 'Elapsed')?.[2]).toBe('28:04 moving · 2 pauses')
  })

  it('judges elapsed against its own usual when there is no moving time and no pause to set beside it', async () => {
    const page = workoutPageFixture()
    const { movingTime: _m, ...figures } = page.figures
    const card = cardLabelled(await mount({ ...page, figures }), 'More about this workout')!
    expect(rowsIn(card).find(([label]) => label === 'Elapsed')).toEqual(['Elapsed', '34:00', 'within your usual 27:00 – 35:00'])
  })

  it('counts a swim\'s lengths and names the pool they were swum in', async () => {
    const page = workoutPageFixture()
    const swim: WorkoutPageData = {
      ...page, exerciseType: 'SWIMMING',
      figures: { swimLengths: { ...page.figures.calories!, key: 'swimLengths', metric: 'swimLengths', unit: 'count', value: 40, baseline: null, standing: null, judged: null } },
    }
    const session = workoutSessionFixture()
    const card = cardLabelled(await mount(swim, { ...session, attrs: { exerciseType: 'SWIMMING', exerciseMetadata: { poolLengthMillimeters: 25_000 } } }), 'More about this workout')!
    expect(rowsIn(card)).toEqual([['Lengths', '40', '25 m pool · no usual yet']])
  })

  it('is left out when none of its figures has a reading', async () => {
    const page = workoutPageFixture()
    const host = await mount({ ...page, figures: { pace: page.figures.pace! } })
    expect(cardLabelled(host, 'More about this workout')).toBeUndefined()
  })
})

describe('the workout page\'s day', () => {
  // The night's day before, for the day of: SideCard, the log, the rows, and no fake row for the
  // workouts the day did not have.
  it('draws the day\'s mood, chips, steps and active minutes in the shared side layout', async () => {
    const card = cardLabelled(await mount(workoutPageFixture()), 'That day')!
    expect(card.querySelector('.detail-side')).not.toBeNull()
    expect(text(card, '.detail-side-caption')).toBe('Friday, September 4, the day of this workout')
    expect(text(card, '.day-log-mood-word')).toBe('Great')
    expect([...card.querySelectorAll('.day-log-chip')].map((chip) => chip.textContent)).toEqual(['Caffeine'])
    expect(rowsIn(card)).toEqual([
      ['Steps', '12,880', 'above your usual 6,000 – 10,500'],
      ['Active minutes', '61\u00a0min', 'above your usual 25 – 60\u00a0min'],
    ])
    expect(card.querySelector('.today-workouts')).toBeNull()
    expect(card.textContent).not.toContain('only this one')
  })

  it('links every other workout that day to its own page', async () => {
    const page = workoutPageFixture()
    const other = { ...workoutSessionFixture(), id: 'walk1', attrs: { exerciseType: 'WALKING' }, startMs: START - 3_600_000, endMs: START - 1_800_000 }
    const card = cardLabelled(await mount({ ...page, day: { ...page.day, otherWorkouts: [other] } }), 'That day')!
    expect(text(card, '.today-workouts > .label')).toBe('Workouts')
    const link = card.querySelector<HTMLAnchorElement>('.today-workouts a.session-row-link')
    expect(text(link!, '.session-row-type')).toBe('Walking')
    expect(text(link!, '.session-row-duration')).toBe('30 min')
    expect(link?.getAttribute('href')).toBe('/activity/walk1')
  })

  it('is left out when the day has no log, no figures and no other workout', async () => {
    const page = workoutPageFixture()
    const blank = { value: null, standing: null, judged: null }
    const host = await mount({
      ...page,
      day: { steps: { ...page.day.steps, ...blank }, activeMinutes: { ...page.day.activeMinutes, ...blank }, otherWorkouts: [] },
      log: { ...page.log, mood: null, counts: {}, note: null },
    }, strengthSessionFixture())
    expect(cardLabelled(host, 'That day')).toBeUndefined()
  })
})

describe('the workout page\'s afterwards', () => {
  it('draws the night after, linked to its page, and the next morning\'s resting heart rate', async () => {
    const card = cardLabelled(await mount(workoutPageFixture()), 'Afterwards')!
    expect(text(card, '.detail-side-caption')).toBe('the night after this workout and the morning after it')
    expect(rowsIn(card)).toEqual([
      ['Time asleep', '7h\u00a012m', 'within your usual 5h\u00a030m – 7h\u00a050m'],
      ['Deep sleep', '1h\u00a022m', 'within your usual 1h\u00a010m – 1h\u00a040m'],
      ['Resting heart rate', '55\u00a0bpm', 'within your usual 51 – 57\u00a0bpm'],
    ])
    const link = card.querySelector<HTMLAnchorElement>('a.card-link')
    expect(link?.textContent).toBe('View the night')
    expect(link?.getAttribute('href')).toBe('/sleep/night/2026-09-05')
  })

  it('keeps the resting heart rate without a night', async () => {
    const page = workoutPageFixture()
    const card = cardLabelled(await mount({ ...page, after: { ...page.after, night: null } }), 'Afterwards')!
    expect(rowsIn(card).map(([label]) => label)).toEqual(['Resting heart rate'])
    expect(card.querySelector('a.card-link')).toBeNull()
  })

  it('is left out with neither a night nor a resting heart rate', async () => {
    const page = workoutPageFixture()
    const host = await mount({ ...page, after: { night: null, restingHeartRate: null } })
    expect(cardLabelled(host, 'Afterwards')).toBeUndefined()
  })
})

describe('the workout page\'s about fold', () => {
  it('says who recorded it above the fold, and keeps the sources, the route sentence and the annotate button inside it', async () => {
    const host = await mount(workoutPageFixture(), { ...fullSession(), sources: ['watch', 'phone'], alternateIds: ['phone-run'] })
    const card = cardLabelled(host, 'About this workout')!
    expect(text(card, '.detail-about-line')).toBe('Recorded by watch, merged with phone · exclude or add a note')
    const details = card.querySelector('details.detail-about')!
    // happy-dom does not hide a closed <details>' children, so the attribute is what is asserted.
    expect(details.hasAttribute('open')).toBe(false)
    expect(text(details, 'summary')).toBe('Details')
    expect(text(details, '.workout-also')).toBe('Also recorded by phone')
    expect(details.querySelector('.workout-gps')).not.toBeNull()
    expect(details.querySelector('.workout-actions button')?.textContent).toBe('Exclude or add a note')
    // Nothing of it is left in the header.
    expect(host.querySelector('.dash-header .workout-also, .dash-header .workout-gps, .dash-header .workout-excluded')).toBeNull()
    expect(host.querySelectorAll('.workout-actions')).toHaveLength(1)
  })

  it('says a workout is excluded above the fold, with the reason inside it', async () => {
    const host = await mount(workoutPageFixture(), { ...workoutSessionFixture(), excluded: true, excludeReason: 'duplicate' })
    const card = cardLabelled(host, 'About this workout')!
    expect(text(card, '.detail-about-line')).toBe('Recorded by watch · excluded · exclude or add a note')
    expect(card.querySelector('details .workout-excluded')?.textContent).toContain('duplicate')
  })

  it('opens the annotate panel from inside the fold', async () => {
    const host = await mount(workoutPageFixture(), { ...workoutSessionFixture(), alternateIds: ['phone-run'] })
    act(() => { host.querySelector<HTMLButtonElement>('details.detail-about .workout-actions button')!.click() })
    expect(host.querySelector('.annotate-panel')).not.toBeNull()
  })

  it('words the lower sections in Dutch', async () => {
    const host = await mount(workoutPageFixture(), workoutSessionFixture(), 'nl')
    expect(rowsIn(cardLabelled(host, 'Loopvorm')!)[2]).toEqual(['Grondcontact', '248\u00a0ms', 'binnen je gebruikelijke bereik 240 – 262\u00a0ms'])
    expect(cardLabelled(host, 'Meer over deze training')).toBeDefined()
    expect(text(cardLabelled(host, 'Die dag')!, '.detail-side-caption')).toBe('vrijdag 4 september, de dag van deze training')
    expect(rowsIn(cardLabelled(host, 'Die dag')!)[0]?.[0]).toBe('Stappen')
    expect(rowsIn(cardLabelled(host, 'Daarna')!)[2]?.[0]).toBe('Rusthartslag')
    expect(cardLabelled(host, 'Daarna')!.querySelector('a.card-link')?.textContent).toBe('Bekijk de nacht')
    expect(text(cardLabelled(host, 'Over deze training')!, '.detail-about-line')).toBe('Opgenomen door watch · uitsluiten of een notitie toevoegen')
  })
})
