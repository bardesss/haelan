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

/** Answers each /glance URL from `bodies` by its `day` (or 'today'); a body of `{ nearest }` answers 404. */
function stubFetch(bodies: Record<string, Glance | { nearest: string }>, seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    const json = (value: unknown, code = 200) =>
      new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
    if (url.includes('/glance')) {
      const day = new URL(url, 'http://x').searchParams.get('day') ?? 'today'
      const body = bodies[day]
      if (body === undefined) return json({ error: 'internal' }, 500)
      return 'nearest' in body ? json(body, 404) : json(body)
    }
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function mountPage(bodies: Record<string, Glance | { nearest: string }>): Promise<{ seen: string[], client: QueryClient, restore: () => void }> {
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
