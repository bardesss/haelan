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
import { CHART_VARS } from '../src/charts/tokens.js'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { navigate } from '../src/router.js'
import { pumpUntil } from './flush.js'
import {
  NAV_PREVIOUS_ID, NEXT_ID, PREVIOUS_ID, WORKOUT_ID,
  strengthPageFixture, strengthSessionFixture, workoutPageFixture, workoutSessionFixture,
} from './fixtures/workoutPage.js'

// happy-dom applies no stylesheet, so the page's charts throw "missing chart token" without this.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

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
function stubFetch(page: Answer): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/workout/')) return json(page.body, page.status)
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({ items: [], cursor: null })
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
}

async function mount(
  page: WorkoutPageData | null, session: WorkoutSessionDetail = workoutSessionFixture(),
  lng: 'en' | 'nl' = 'en', answer: Answer = NO_SUCH_WORKOUT,
): Promise<HTMLDivElement> {
  stubFetch(answer)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  client.setQueryData(queryKeys.resource('p1', 'session', { sessionId: WORKOUT_ID }), session)
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
  return [...host.querySelectorAll('.workout-minis .figure-row')].map((row) => [
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
  it('is titled with the exercise type and says when it ran, who recorded it and what the note says', async () => {
    const host = await mount(workoutPageFixture())
    expect(text(host, '.workout-page h1')).toBe('Running')
    expect(text(host, '.workout-when')).toBe('Friday, September 4, 18:00–18:34 · watch')
    expect(text(host, '.workout-note')).toBe('“Easy start, pushed the last kilometre.”')
  })

  it('names the workout under the type only when the name says something the type does not', async () => {
    // The fixture's displayName is "Running", the type's own label: said once, not twice.
    expect((await mount(workoutPageFixture())).querySelector('.workout-name')).toBeNull()
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const session = workoutSessionFixture()
    const named = { ...session, attrs: { ...(session.attrs as object), displayName: 'Morning run' } }
    expect(text(await mount(workoutPageFixture(), named), '.workout-name')).toBe('Morning run')
  })

  it('says nothing about a note the workout does not have', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(host.querySelector('.workout-note')).toBeNull()
  })

  it('steps to the neighbouring workouts the payload names, of any type', async () => {
    const host = await mount(workoutPageFixture())
    act(() => { button(host, 'Previous workout')!.click() })
    expect(window.location.pathname).toBe(`/activity/${NAV_PREVIOUS_ID}`)
    act(() => { navigate(`/activity/${WORKOUT_ID}`) })
    act(() => { button(host, 'Next workout')!.click() })
    expect(window.location.pathname).toBe(`/activity/${NEXT_ID}`)
  })

  it('disables the arrow with no workout behind it', async () => {
    const host = await mount({ ...workoutPageFixture(), nav: { previous: NAV_PREVIOUS_ID, next: null } })
    expect(button(host, 'Next workout')!.disabled).toBe(true)
    expect(button(host, 'Previous workout')!.disabled).toBe(false)
  })

  it('links back to every workout', async () => {
    const host = await mount(workoutPageFixture())
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'All workouts →')
    expect(link?.getAttribute('href')).toBe('/activity')
  })
})

describe('the workout page\'s hero', () => {
  it('leads with the pace, where it sits against the usual, and how it ranks among recent runs', async () => {
    const host = await mount(workoutPageFixture())
    expect(host.querySelector('.workout-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Pace')
    expect(text(host, '.workout-hero-value')).toBe('5:24 /km')
    expect(text(host, '.workout-hero-verdict')).toBe('within your usual 5:22 /km – 5:36 /km')
    expect(text(host, '.workout-hero-rank')).toBe('Faster than 17 of your last 20 of this type')
    expect(text(host, '.workout-hero .dash-caption')).toBe('this workout and the nine of this type before it')
    expect(host.querySelector('.workout-hero [role="img"][aria-label="Pace"]')).not.toBeNull()
  })

  it('says how it compares with the previous one of this type, and links to it', async () => {
    const host = await mount(workoutPageFixture())
    expect(text(host, '.workout-hero-previous')).toBe('12 s/km faster than the previous one, Tuesday, September 1 · view →')
    expect(host.querySelector('.workout-hero-previous a')?.getAttribute('href')).toBe(`/activity/${PREVIOUS_ID}`)
  })

  it('says slower, not a negative faster, when the pace was slower', async () => {
    const page = workoutPageFixture()
    const host = await mount({ ...page, previous: { ...page.previous!, values: { ...page.previous!.values, pace: 318 } } })
    expect(text(host, '.workout-hero-previous')).toBe('6 s/km slower than the previous one, Tuesday, September 1 · view →')
  })

  it('names the Records best for this type as "your best"', async () => {
    const host = await mount(workoutPageFixture())
    expect(text(host, '.workout-hero-best')).toBe('Your best: fastest kilometre 4:50 /km (June)')
  })

  it('leads with moving time for a strength session, with no ranking, no previous one and no best', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(host.querySelector('.workout-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Moving time')
    expect(text(host, '.workout-hero-value')).toBe('45:00')
    expect(text(host, '.workout-hero-verdict')).toBe('not enough history for a usual yet')
    expect(host.querySelector('.workout-hero-rank')).toBeNull()
    expect(host.querySelector('.workout-hero-previous')).toBeNull()
    expect(host.querySelector('.workout-hero-best')).toBeNull()
    // One session is one dot, which joins nothing.
    expect(host.querySelector('.workout-hero [role="img"]')).toBeNull()
  })

  it('shades the hero strip with the figure\'s usual band, and draws none for a thin one', async () => {
    const page = workoutPageFixture()
    const bandedHost = await mount(page)
    expect(bandCount(bandedHost.querySelector<HTMLDivElement>('.workout-hero [role="img"]')!)).toBe(10)
    act(() => { root!.unmount() })
    root = createRoot(container!)
    const pace = { ...page.figures.pace!, baseline: { ...page.figures.pace!.baseline!, thin: true }, standing: null, judged: null }
    const thinHost = await mount({ ...page, figures: { ...page.figures, pace } })
    expect(bandCount(thinHost.querySelector<HTMLDivElement>('.workout-hero [role="img"]')!)).toBe(0)
  })
})

describe('the workout page\'s four figures', () => {
  it('are distance, moving time, average heart rate and cardio load, each with its verdict and strip', async () => {
    const host = await mount(workoutPageFixture())
    expect(minis(host)).toEqual([
      ['Distance', '5.20 km', 'within your usual 4.60 km – 5.60 km'],
      ['Moving time', '28:04', 'within your usual 25:00 – 31:00'],
      ['Avg heart rate', '157 bpm', 'within your usual 150 bpm – 158 bpm'],
      ['Cardio load', '71', 'above your usual 55 – 70'],
    ])
    expect(host.querySelectorAll('.workout-minis [role="img"]')).toHaveLength(4)
    expect(text(host, '.workout-minis .dash-caption')).toBe('each line: this workout and the nine of this type before it · band = your usual range')
  })

  it('leave out a figure the workout has no reading for, and the one the hero already leads with', async () => {
    const host = await mount(strengthPageFixture(), strengthSessionFixture())
    expect(minis(host).map(([label]) => label)).toEqual(['Avg heart rate'])
  })

  it('leave out the whole card when none of the four has a reading', async () => {
    const page = workoutPageFixture()
    const { distance: _d, movingTime: _m, averageHeartRate: _a, cardioLoad: _c, ...rest } = page.figures
    const host = await mount({ ...page, figures: rest })
    expect(host.querySelector('.workout-minis')).toBeNull()
  })
})

describe('the workout page\'s compared-with table', () => {
  it('sets this workout beside the previous one, the usual and the best, row by row', async () => {
    const host = await mount(workoutPageFixture())
    expect([...host.querySelectorAll('.workout-compared thead th')].map((th) => th.textContent)).toEqual([
      '', 'This workout', 'Previous · Sep 1', 'Usual', 'Your best',
    ])
    expect(compared(host)).toEqual([
      ['Pace', '5:24 /km', '5:36 /km-12 s', '5:22 /km – 5:36 /km', '4:50 /km · June'],
      ['Distance', '5.20 km', '5.00 km+0.20', '4.60 km – 5.60 km', '10.40 km · May'],
      ['Avg heart rate', '157 bpm', '153 bpm+4', '150 bpm – 158 bpm', '—'],
      ['Cardio load', '71', '62+9', '55 – 70', '—'],
    ])
    expect(host.querySelector('.workout-compared thead a')?.getAttribute('href')).toBe(`/activity/${PREVIOUS_ID}`)
  })

  it('colours a difference only where the figure has a better direction', async () => {
    const host = await mount(workoutPageFixture())
    const diffs = [...host.querySelectorAll('.workout-compared .workout-diff')].map((span) => span.className)
    // Faster pace is better (direction down, and 12 s less); more distance, heart rate or load is
    // neither, so those stay the plain colour.
    expect(diffs).toEqual(['workout-diff better', 'workout-diff', 'workout-diff', 'workout-diff'])
  })

  it('drops the best column on a phone', async () => {
    const host = await mount(workoutPageFixture())
    const best = host.querySelectorAll('.workout-compared .workout-compared-best')
    expect(best).toHaveLength(5)
    const css = readFileSync('apps/web/src/app.css', 'utf8')
    expect(css).toMatch(/@media \(max-width: 620px\) \{[^}]*\.workout-compared-best \{ display: none; \}/)
  })

  it('leaves out a row the workout has no value for, and the previous column when there is no previous one', async () => {
    const page = workoutPageFixture()
    const { pace: _p, ...rest } = page.figures
    const host = await mount({ ...page, figures: rest, previous: null })
    expect(compared(host).map((row) => row[0])).toEqual(['Distance', 'Avg heart rate', 'Cardio load'])
    expect([...host.querySelectorAll('.workout-compared thead th')].map((th) => th.textContent)).toEqual([
      '', 'This workout', 'Usual', 'Your best',
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
    expect(host.querySelector('.workout-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Tempo')
    expect(text(host, '.workout-hero-rank')).toBe('Sneller dan 17 van je laatste 20 van dit type')
    expect(text(host, '.workout-hero-previous')).toBe('12 s/km sneller dan de vorige, dinsdag 1 september · bekijk →')
    expect(text(host, '.workout-hero-best')).toBe('Je beste: snelste kilometer 4:50 /km (juni)')
    expect(text(host, '.workout-page h1')).toBe('Hardlopen')
  })
})

describe('the workout page without a workout', () => {
  it('says there is no such workout when the page read answers 404', async () => {
    const host = await mount(null)
    expect(host.innerHTML).toContain('No such workout')
    expect(host.querySelector('.workout-page')).toBeNull()
  })

  it('offers a retry when the page read fails for any other reason', async () => {
    const host = await mount(null, workoutSessionFixture(), 'en', { status: 500, body: { error: { code: 'internal', message: 'boom' } } })
    expect(host.innerHTML).not.toContain('No such workout')
    expect(host.querySelector('button')?.textContent).toBe('Try again')
  })
})
