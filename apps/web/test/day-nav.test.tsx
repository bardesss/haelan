// @vitest-environment happy-dom
// happy-dom: the header's buttons are clicked and its keys pressed for real, and the page cases mount
// the Dashboard and let its query settle, the same way glance-page.test.tsx does.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Dashboard } from '../src/pages/Dashboard.js'
import { DayNav } from '../src/pages/dashboard/DayNav.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { Session } from '../src/auth/session.js'
import type { Glance } from '../src/data/useGlance.js'
import { glanceBody } from './glanceFixture.js'
import { flush } from './flush.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
  // 09:40 UTC on the 23rd is 11:40 in Amsterdam: a morning, and the 23rd is today.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 40))
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

/** Today's glance with a day before it to step back to. */
function todayGlance(): Glance {
  return { ...glanceBody(), nav: { previous: '2026-09-22', next: null } }
}

/** Tuesday the 22nd as a finished day, with neighbours either side unless a test says otherwise. */
function pastGlance(nav: Glance['nav'] = { previous: '2026-09-21', next: '2026-09-23' }): Glance {
  return { ...glanceBody(), today: '2026-09-22', finished: true, nav }
}

type Body = Glance | { nearest: string } | Promise<Glance>

/** Answers each /glance URL from `bodies` by its `day` (or 'today'); a body of `{ nearest }` answers 404,
 *  and a promise holds the answer until the test settles it. */
function stubFetch(bodies: Record<string, Body>, seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    const json = (value: unknown, code = 200) =>
      new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
    if (url.includes('/glance/calendar')) {
      // Every day of September to today has data; enough for the page tests to open the calendar.
      const days = Array.from({ length: 23 }, (_, i) => ({ localDate: `2026-09-${String(i + 1).padStart(2, '0')}`, sleep: 'within', steps: 'reached' }))
      return json({ month: '2026-09', firstDay: '2026-09-01', days })
    }
    if (url.includes('/glance')) {
      const day = new URL(url, 'http://x').searchParams.get('day') ?? 'today'
      const body = await bodies[day]
      if (body === undefined) return json({ error: 'internal' }, 500)
      return 'nearest' in body ? json(body, 404) : json(body)
    }
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function mountPage(bodies: Record<string, Body>): Promise<{ seen: string[], client: QueryClient, restore: () => void }> {
  const seen: string[] = []
  const restore = stubFetch(bodies, seen)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root!.render(<I18nProvider lng="en"><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></I18nProvider>)
  })
  await flush(client, () => container!.innerHTML + window.location.search)
  return { seen, client, restore }
}

function mountNav(glance: Glance, onPick: (day: string | null) => void, extra: ReactNode = null): void {
  act(() => {
    root!.render(<I18nProvider lng="en">{extra}<DayNav glance={glance} onPick={onPick} /></I18nProvider>)
  })
}

const button = (name: string): HTMLButtonElement | undefined =>
  [...container!.querySelectorAll<HTMLButtonElement>('.day-nav button')].find((b) => b.getAttribute('aria-label') === name || b.textContent === name)
const heading = (): string | null | undefined => container!.querySelector('h1')?.textContent
const subLine = (): string | null | undefined => container!.querySelector('.dash-date')?.textContent

function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

describe('the dashboard header, today', () => {
  it('keeps the greeting and the date line, with the arrows at the right and no Today button', async () => {
    const { restore } = await mountPage({ today: todayGlance() })
    try {
      expect(heading()).toBe('Good morning')
      expect(subLine()).toBe('Wednesday, September 23 · last night, and today until 11:38')
      const header = container!.querySelector('.dash-header')!
      expect([...header.children].map((el) => el.className)).toEqual(['dash-heading', 'day-nav'])
      expect(button('Previous day')!.disabled).toBe(false)
      expect(button('Next day')!.disabled).toBe(true)
      expect(button('Today')).toBeUndefined()
    } finally { restore() }
  })

  it('disables the previous arrow on the first day with data', async () => {
    const { restore } = await mountPage({ today: { ...todayGlance(), nav: { previous: null, next: null } } })
    try {
      expect(button('Previous day')!.disabled).toBe(true)
    } finally { restore() }
  })
})

describe('the dashboard header, a past day', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?day=2026-09-22') })

  it('titles the page with the date, says what it shows, and offers Today', async () => {
    const { seen, restore } = await mountPage({ '2026-09-22': pastGlance() })
    try {
      expect(seen.filter((u) => u.includes('/glance'))).toEqual(['/api/v1/p/p1/glance?day=2026-09-22'])
      expect(heading()).toBe('Tuesday, September 22')
      expect(subLine()).toBe('that night, and the whole day')
      expect(button('Previous day')!.disabled).toBe(false)
      expect(button('Next day')!.disabled).toBe(false)
      expect(button('Today')!.disabled).toBe(false)
    } finally { restore() }
  })

  it('disables next exactly when there is no later day, and previous exactly when there is no earlier one', async () => {
    const { restore } = await mountPage({ '2026-09-22': pastGlance({ previous: null, next: null }) })
    try {
      expect(button('Previous day')!.disabled).toBe(true)
      expect(button('Next day')!.disabled).toBe(true)
      // The way back when yesterday has no next (today holds no data yet).
      expect(button('Today')!.disabled).toBe(false)
    } finally { restore() }
  })

  it('steps through the URL: the previous arrow opens the day before, Today drops the parameter', async () => {
    const { client, restore } = await mountPage({ '2026-09-22': pastGlance(), '2026-09-21': { ...pastGlance(), today: '2026-09-21' }, today: todayGlance() })
    try {
      act(() => { button('Previous day')!.click() })
      expect(window.location.search).toBe('?day=2026-09-21')
      await flush(client, () => container!.innerHTML)
      expect(heading()).toBe('Monday, September 21')
      act(() => { button('Today')!.click() })
      expect(window.location.search).toBe('')
      await flush(client, () => container!.innerHTML)
      expect(heading()).toBe('Good morning')
    } finally { restore() }
  })

  it('opens the calendar on the shown day, and a day picked there goes into the URL, today as none', async () => {
    const { client, seen, restore } = await mountPage({ '2026-09-22': pastGlance(), '2026-09-21': { ...pastGlance(), today: '2026-09-21' }, today: todayGlance() })
    try {
      const calendar = () => document.querySelector('[data-calendar]')
      act(() => { button('Pick a date')!.click() })
      await flush(client, () => document.body.innerHTML)
      expect(seen.filter((u) => u.includes('/glance/calendar'))).toEqual(['/api/v1/p/p1/glance/calendar?month=2026-09'])
      expect(document.querySelector('[data-day="2026-09-22"]')!.className).toBe('cal-day is-selected')
      act(() => { document.querySelector<HTMLButtonElement>('[data-day="2026-09-21"]')!.click() })
      expect(calendar()).toBeNull()
      expect(window.location.search).toBe('?day=2026-09-21')
      await flush(client, () => container!.innerHTML)
      act(() => { button('Pick a date')!.click() })
      await flush(client, () => document.body.innerHTML)
      act(() => { document.querySelector<HTMLButtonElement>('.cal-today')!.click() })
      expect(window.location.search).toBe('')
    } finally { restore() }
  })

  it('replaces the URL with the nearest day when the asked-for day has no data', async () => {
    window.history.replaceState(null, '', '/?day=2026-09-21')
    const before = window.history.length
    const { restore } = await mountPage({ '2026-09-21': { nearest: '2026-09-20' }, '2026-09-20': { ...pastGlance(), today: '2026-09-20' } })
    try {
      expect(window.location.search).toBe('?day=2026-09-20')
      expect(window.history.length).toBe(before)
      expect(heading()).toBe('Sunday, September 20')
    } finally { restore() }
  })
})

describe('stepping to a day not yet loaded', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?day=2026-09-22') })

  /** Lets the page render what it has without waiting for the held fetch. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }

  it('keeps the header and the previous cards, names the new day, and holds the arrows until it arrives', async () => {
    let release: (body: Glance) => void = () => {}
    const held = new Promise<Glance>((resolve) => { release = resolve })
    const { client, restore } = await mountPage({ '2026-09-22': pastGlance(), '2026-09-21': held })
    try {
      press('ArrowLeft')
      expect(window.location.search).toBe('?day=2026-09-21')
      await settle()
      // Still the page, not the loading state: the row did not vanish under the pointer.
      expect(container!.querySelector('.empty')).toBeNull()
      expect(container!.querySelectorAll('.dashboard-grid > section.card').length).toBeGreaterThan(0)
      expect(container!.querySelector('.dashboard-grid')!.className).toBe('grid dashboard-grid dashboard-grid-stale')
      expect(heading()).toBe('Monday, September 21')
      expect(subLine()).toBe('that night, and the whole day')
      expect(button('Previous day')!.disabled).toBe(true)
      expect(button('Next day')!.disabled).toBe(true)
      expect(button('Today')!.disabled).toBe(false)
      // A second ← while the day loads would step from the 22nd's stale nav: it does nothing.
      press('ArrowLeft')
      expect(window.location.search).toBe('?day=2026-09-21')

      release({ ...pastGlance({ previous: '2026-09-20', next: '2026-09-22' }), today: '2026-09-21' })
      await flush(client, () => container!.innerHTML)
      expect(container!.querySelector('.dashboard-grid')!.className).toBe('grid dashboard-grid')
      expect(heading()).toBe('Monday, September 21')
      expect(button('Previous day')!.disabled).toBe(false)
      expect(button('Next day')!.disabled).toBe(false)
    } finally { restore() }
  })

  it("never holds another person's day on screen", async () => {
    const { client, restore } = await mountPage({ '2026-09-22': pastGlance() })
    try {
      // The placeholder is the previous answer only when that answer was the same person's.
      const options = client.getQueryCache().findAll({ queryKey: ['person', 'p1', 'glance'] })[0]!.options as {
        placeholderData?: (previous: unknown, previousQuery?: { queryKey: readonly unknown[] }) => unknown
      }
      const glance = pastGlance()
      expect(options.placeholderData!(glance, { queryKey: ['person', 'p1', 'glance', '2026-09-21'] })).toBe(glance)
      expect(options.placeholderData!(glance, { queryKey: ['person', 'p2', 'glance', '2026-09-21'] })).toBeUndefined()
    } finally { restore() }
  })
})

describe('the dashboard header on a phone', () => {
  const realMatchMedia = window.matchMedia.bind(window)
  beforeEach(() => {
    window.history.replaceState(null, '', '/?day=2026-09-22')
    window.matchMedia = ((query: string) => {
      if (query !== PHONE_MEDIA_QUERY) return realMatchMedia(query)
      return {
        matches: true, media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
      } as unknown as MediaQueryList
    }) as typeof window.matchMedia
  })
  afterEach(() => { window.matchMedia = realMatchMedia as typeof window.matchMedia })

  it('titles a past day with the short date, so the header stays one line', async () => {
    const { restore } = await mountPage({ '2026-09-22': pastGlance() })
    try {
      expect(heading()).toBe('Tue, Sep 22')
    } finally { restore() }
  })
})

describe('DayNav', () => {
  it('names every control and the key that presses it', () => {
    mountNav(pastGlance(), () => {})
    const names = [...container!.querySelectorAll('.day-nav button')].map((b) => [b.getAttribute('aria-label') ?? b.textContent, b.getAttribute('aria-keyshortcuts')])
    expect(names).toEqual([['Previous day', 'ArrowLeft'], ['Next day', 'ArrowRight'], ['Pick a date', null], ['Today', 'T']])
    expect(button('Previous day')!.title).toBe('Previous day (←)')
    expect(button('Next day')!.title).toBe('Next day (→)')
    expect(button('Today')!.title).toBe('Today (T)')
    expect(container!.querySelector('.day-nav')!.getAttribute('aria-label')).toBe('Day')
  })

  it('holds a slot for the calendar button, disabled until one is handed in', () => {
    mountNav(pastGlance(), () => {})
    expect(button('Pick a date')!.disabled).toBe(true)
    act(() => {
      root!.render(<I18nProvider lng="en"><DayNav glance={pastGlance()} onPick={() => {}} calendarButton={<button type="button">cal</button>} /></I18nProvider>)
    })
    expect(button('Pick a date')).toBeUndefined()
    expect(button('cal')).toBeDefined()
  })

  it('clicking an arrow picks its neighbour', () => {
    const onPick = vi.fn()
    mountNav(pastGlance(), onPick)
    act(() => { button('Previous day')!.click() })
    act(() => { button('Next day')!.click() })
    act(() => { button('Today')!.click() })
    expect(onPick.mock.calls).toEqual([['2026-09-21'], ['2026-09-23'], [null]])
  })

  it('← and → step and T returns to today', () => {
    const onPick = vi.fn()
    mountNav(pastGlance(), onPick)
    press('ArrowLeft')
    press('ArrowRight')
    press('t')
    press('T')
    expect(onPick.mock.calls).toEqual([['2026-09-21'], ['2026-09-23'], [null], [null]])
  })

  it('a key toward no neighbour does nothing, and T on today does nothing', () => {
    const onPick = vi.fn()
    mountNav(todayGlance(), onPick)
    press('ArrowRight')
    press('t')
    expect(onPick).not.toHaveBeenCalled()
    press('ArrowLeft')
    expect(onPick.mock.calls).toEqual([['2026-09-22']])
  })

  it('ignores keys typed in a field, a select, with a modifier, or inside the calendar', () => {
    const onPick = vi.fn()
    mountNav(pastGlance(), onPick, (
      <>
        <input data-testid="field" />
        <textarea data-testid="area" />
        <select data-testid="pick"><option>a</option></select>
        <div data-calendar=""><button type="button" data-testid="in-calendar">22</button></div>
      </>
    ))
    for (const id of ['field', 'area', 'pick', 'in-calendar']) {
      const target = container!.querySelector(`[data-testid="${id}"]`)!
      press('ArrowLeft', target)
      press('ArrowRight', target)
      press('t', target)
    }
    press('ArrowLeft', document.body, { shiftKey: true })
    press('ArrowLeft', document.body, { ctrlKey: true })
    expect(onPick).not.toHaveBeenCalled()
  })
})
