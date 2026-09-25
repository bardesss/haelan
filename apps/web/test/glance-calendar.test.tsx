// @vitest-environment happy-dom
// happy-dom: the calendar is opened, clicked and driven by keys for real, and its month queries
// settle through a stubbed fetch the way day-nav.test.tsx lets the glance settle.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CalendarButton } from '../src/pages/dashboard/GlanceCalendar.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'
import type { Session } from '../src/auth/session.js'
import type { GlanceCalendar, GlanceCalendarDay } from '../src/data/useGlanceCalendar.js'
import { flush } from './flush.js'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const TODAY = '2026-09-23'

// import.meta.url is an http: URL under happy-dom (brand-mark.test.tsx's note), so the stylesheet is
// found from the working directory, whichever of the root and apps/web the run started in.
const WEB = [process.cwd(), resolve(process.cwd(), 'apps/web')].find((dir) => existsSync(join(dir, 'src/app.css')))!

function day(localDate: string, sleep: GlanceCalendarDay['sleep'] = 'within', steps: GlanceCalendarDay['steps'] = 'reached'): GlanceCalendarDay {
  return { localDate, sleep, steps }
}

const pad = (n: number) => String(n).padStart(2, '0')

// September 2026 starts on a Tuesday. Data on the 1st to the 23rd (today) except the weekend of
// the 12th and 13th. The 24th is listed too, which the server never does, so that the client's own
// "no future days" rule is what keeps it grey.
const VERDICTS: Record<number, [GlanceCalendarDay['sleep'], GlanceCalendarDay['steps']]> = {
  5: ['outside', 'reached'], 9: [null, 'reached'], 15: ['outside', 'below'], 22: ['within', 'below'], 23: ['within', null],
}
const SEPTEMBER: GlanceCalendar = {
  month: '2026-09',
  firstDay: '2026-08-10',
  days: [...Array.from({ length: 23 }, (_, i) => i + 1).filter((d) => d !== 12 && d !== 13), 24]
    .map((d) => day(`2026-09-${pad(d)}`, ...(VERDICTS[d] ?? ['within', 'reached']))),
}
// The first month with data. The 5th is listed although it is before firstDay, which again only
// the client's rule can keep grey.
const AUGUST: GlanceCalendar = {
  month: '2026-08',
  firstDay: '2026-08-10',
  days: [5, ...Array.from({ length: 22 }, (_, i) => i + 10)].map((d) => day(`2026-08-${pad(d)}`)),
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let client: QueryClient | null = null
let seen: string[] = []
let restoreFetch: (() => void) | null = null
const realShowModal = HTMLDialogElement.prototype.showModal
const realClose = HTMLDialogElement.prototype.close
const realMatchMedia = window.matchMedia
let phone = false

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  phone = false
  window.matchMedia = ((query: string) => ({
    get matches() { return phone && query === PHONE_MEDIA_QUERY },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  // 09:40 UTC on the 23rd is 11:40 in Amsterdam: the 23rd is today, and September the current month.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 40))
  seen = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    const month = new URL(url, 'http://x').searchParams.get('month')
    const body = month === '2026-09' ? SEPTEMBER : month === '2026-08' ? AUGUST : null
    return new Response(JSON.stringify(body ?? { error: 'bad_request' }), { status: body === null ? 400 : 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  restoreFetch?.()
  vi.useRealTimers()
  HTMLDialogElement.prototype.showModal = realShowModal
  HTMLDialogElement.prototype.close = realClose
  window.matchMedia = realMatchMedia
})

/** Mounts the calendar button for `selected` and opens it, letting the month's query settle. */
async function open(selected = '2026-09-22', lng = 'en'): Promise<string[]> {
  const picks: string[] = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root!.render(
      <I18nProvider lng={lng}><QueryClientProvider client={client!}>
        <CalendarButton selected={selected} today={TODAY} onPick={(d) => picks.push(d)} />
      </QueryClientProvider></I18nProvider>,
    )
  })
  act(() => { trigger().click() })
  await settle()
  return picks
}

const settle = () => flush(client!, () => document.body.innerHTML)
const trigger = () => container!.querySelector<HTMLButtonElement>('button[aria-haspopup]')!
const panel = () => document.querySelector<HTMLElement>('[data-calendar]')
const cell = (localDate: string) => document.querySelector<HTMLButtonElement>(`[data-day="${localDate}"]`)
const title = () => document.querySelector('.cal-title')?.textContent
const monthButton = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const calendarUrls = () => seen.filter((u) => u.includes('/glance/calendar'))

function press(key: string, target: Element | null = document.activeElement): void {
  act(() => { target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

describe('the calendar month', () => {
  it('opens on the selected day\'s month, weeks from Monday, initials in the page language', async () => {
    await open()
    expect(calendarUrls()).toEqual(['/api/v1/p/p1/glance/calendar?month=2026-09'])
    expect(title()).toBe('September 2026')
    expect([...document.querySelectorAll('.cal-weekday')].map((el) => el.textContent)).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
    // The 1st is a Tuesday: one blank before it in the first week.
    const firstWeek = document.querySelectorAll('.cal-week')[0]!
    expect([...firstWeek.children].map((c) => c.querySelector('[data-day]')?.getAttribute('data-day') ?? null))
      .toEqual([null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'])
  })

  it('names the month and the weekdays in Dutch on a Dutch page', async () => {
    await open('2026-09-22', 'nl')
    expect(title()).toBe('september 2026')
    expect([...document.querySelectorAll('.cal-weekday')].map((el) => el.textContent)).toEqual(['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'])
  })

  it('makes each day with data a button named with its date and both verdicts in words', async () => {
    await open()
    const tuesday = cell('2026-09-22')!
    expect(tuesday.getAttribute('aria-label')).toBe('Tuesday, September 22, slept in your usual range, steps below your usual')
    expect(tuesday.hasAttribute('aria-disabled')).toBe(false)
    expect(cell('2026-09-05')!.getAttribute('aria-label')).toBe('Saturday, September 5, slept outside your usual range, steps reached your usual')
    expect(cell('2026-09-09')!.getAttribute('aria-label')).toBe('Wednesday, September 9, sleep not judged, steps reached your usual')
    expect(cell('2026-09-23')!.getAttribute('aria-label')).toBe('Wednesday, September 23, slept in your usual range, steps not judged')
  })

  it('greys and blocks a day without data, a future day and a day before the first', async () => {
    const picks = await open()
    for (const [date, name] of [
      ['2026-09-12', 'Saturday, September 12, no data'],
      ['2026-09-24', 'Thursday, September 24, no data'],
    ] as const) {
      const grey = cell(date)!
      expect(grey.getAttribute('aria-disabled')).toBe('true')
      expect(grey.getAttribute('aria-label')).toBe(name)
      expect(grey.tabIndex).toBe(-1)
      expect(grey.className).toBe('cal-day is-off')
      act(() => { grey.click() })
    }
    expect(picks).toEqual([])
    expect(panel()).not.toBeNull()

    act(() => { monthButton('Previous month').click() })
    await settle()
    const early = cell('2026-08-05')!
    expect(early.getAttribute('aria-disabled')).toBe('true')
    act(() => { early.click() })
    expect(picks).toEqual([])
    expect(cell('2026-08-10')!.hasAttribute('aria-disabled')).toBe(false)
  })

  it('picks an enabled day on a click, and closes', async () => {
    const picks = await open()
    act(() => { cell('2026-09-15')!.click() })
    expect(picks).toEqual(['2026-09-15'])
    expect(panel()).toBeNull()
  })

  it('draws two dots per day from the server\'s verdicts, and marks the selected day and today', async () => {
    await open()
    const dots = (date: string) => [...cell(date)!.querySelectorAll('.cal-dot')].map((d) => d.className)
    expect(dots('2026-09-01')).toEqual(['cal-dot is-within', 'cal-dot is-reached'])
    expect(dots('2026-09-15')).toEqual(['cal-dot is-outside', 'cal-dot is-below'])
    expect(dots('2026-09-09')).toEqual(['cal-dot is-none', 'cal-dot is-reached'])
    expect(dots('2026-09-23')).toEqual(['cal-dot is-within', 'cal-dot is-none'])
    expect(dots('2026-09-12')).toEqual([])
    expect(cell('2026-09-22')!.className).toBe('cal-day is-selected')
    expect(cell('2026-09-22')!.parentElement!.getAttribute('aria-selected')).toBe('true')
    expect(cell('2026-09-23')!.className).toBe('cal-day is-today')
    expect(cell('2026-09-21')!.className).toBe('cal-day')
  })
})

describe('the calendar stylesheet', () => {
  const css = readFileSync(join(WEB, 'src/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[}\\s,])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? null
  }

  it('draws the selected day\'s dots in the page colour, so both stay visible on the accent fill', () => {
    expect(rule('.cal-day.is-selected')).toContain('background: var(--accent)')
    expect(rule('.cal-day.is-selected .cal-dot')).toContain('background: var(--surface-page)')
  })

  it('outlines today with a border and draws no shadow anywhere in the calendar', () => {
    expect(rule('.cal-day.is-today')).toContain('border-color: var(--border-chosen)')
    const calendarRules = [...css.matchAll(/([^{}]*\.cal-[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]!)
    expect(calendarRules.length).toBeGreaterThan(10)
    expect(calendarRules.filter((body) => body.includes('box-shadow'))).toEqual([])
  })

  it('sizes a day 36px on a desktop and 44px in the phone sheet', () => {
    expect(rule('.cal-day')).toContain('height: 36px')
    expect(rule('.cal-sheet .cal-day')).toContain('height: 44px')
  })
})

describe('the month arrows', () => {
  it('stops at the current month going forward and the first month with data going back, fetching each', async () => {
    await open()
    expect(monthButton('Next month').disabled).toBe(true)
    expect(monthButton('Previous month').disabled).toBe(false)
    act(() => { monthButton('Previous month').click() })
    await settle()
    expect(calendarUrls()).toEqual(['/api/v1/p/p1/glance/calendar?month=2026-09', '/api/v1/p/p1/glance/calendar?month=2026-08'])
    expect(title()).toBe('August 2026')
    expect(monthButton('Previous month').disabled).toBe(true)
    expect(monthButton('Next month').disabled).toBe(false)
    act(() => { monthButton('Next month').click() })
    await settle()
    expect(title()).toBe('September 2026')
  })
})

describe('the calendar keyboard', () => {
  const focused = () => document.activeElement?.getAttribute('data-day') ?? null
  const tabStops = () => [...document.querySelectorAll('[data-day]')].filter((c) => (c as HTMLElement).tabIndex === 0).map((c) => c.getAttribute('data-day'))

  async function openOn(day: string): Promise<string[]> {
    const picks = await open(day)
    expect(focused()).toBe(day)
    return picks
  }

  it('lands on the selected day with one tab stop in the grid', async () => {
    await openOn('2026-09-22')
    expect(tabStops()).toEqual(['2026-09-22'])
  })

  it('moves a day with the side arrows and a week with the up and down arrows', async () => {
    await openOn('2026-09-16')
    press('ArrowRight'); expect(focused()).toBe('2026-09-17')
    press('ArrowLeft'); expect(focused()).toBe('2026-09-16')
    press('ArrowUp'); expect(focused()).toBe('2026-09-09')
    press('ArrowDown'); expect(focused()).toBe('2026-09-16')
    press('ArrowDown'); expect(focused()).toBe('2026-09-23')
    expect(tabStops()).toEqual(['2026-09-23'])
  })

  it('skips a grey day to the next enabled one in the direction of travel', async () => {
    await openOn('2026-09-11')
    press('ArrowRight'); expect(focused()).toBe('2026-09-14')
    press('ArrowLeft'); expect(focused()).toBe('2026-09-11')
    // Up a week from the 19th is the 12th, grey; the next enabled day going back is the 11th.
    press('ArrowDown'); press('ArrowRight'); expect(focused()).toBe('2026-09-19')
    press('ArrowUp'); expect(focused()).toBe('2026-09-11')
    // Down a week from the 6th is the 13th, grey; the next enabled day going forward is the 14th.
    press('ArrowUp'); press('ArrowRight'); expect(focused()).toBe('2026-09-05')
    press('ArrowRight'); press('ArrowDown'); expect(focused()).toBe('2026-09-14')
  })

  it('stays put when nothing enabled lies that way', async () => {
    await openOn('2026-09-23')
    press('ArrowRight'); expect(focused()).toBe('2026-09-23')
    press('ArrowDown'); expect(focused()).toBe('2026-09-23')
  })

  it('goes to the week\'s start and end with Home and End, skipping grey days back toward the start', async () => {
    await openOn('2026-09-17')
    press('Home'); expect(focused()).toBe('2026-09-14')
    press('End'); expect(focused()).toBe('2026-09-20')
    press('ArrowUp'); expect(focused()).toBe('2026-09-11')
    // Sunday the 13th is grey: End stops on the last enabled day of that week.
    press('End'); expect(focused()).toBe('2026-09-11')
  })

  it('moves a month with PageUp and PageDown, and across a month edge with the arrows', async () => {
    await openOn('2026-09-22')
    press('PageUp')
    await settle()
    expect(title()).toBe('August 2026')
    expect(focused()).toBe('2026-08-22')
    press('PageDown')
    await settle()
    expect(title()).toBe('September 2026')
    expect(focused()).toBe('2026-09-22')
    press('ArrowUp'); press('ArrowUp'); press('ArrowUp')
    expect(focused()).toBe('2026-09-01')
    press('ArrowLeft')
    await settle()
    expect(title()).toBe('August 2026')
    expect(focused()).toBe('2026-08-31')
  })

  it('picks with Enter and with Space, closing each time', async () => {
    const picks = await openOn('2026-09-22')
    press('ArrowLeft')
    press('Enter')
    expect(picks).toEqual(['2026-09-21'])
    expect(panel()).toBeNull()
    act(() => { trigger().click() })
    await settle()
    press(' ')
    expect(picks).toEqual(['2026-09-21', '2026-09-22'])
  })

  it('closes on Escape and gives focus back to the calendar button', async () => {
    const picks = await openOn('2026-09-22')
    press('Escape')
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(picks).toEqual([])
  })
})

describe('the calendar\'s layer', () => {
  it('is a portalled popover on a desktop, placed inline, closing on a press outside', async () => {
    await open()
    const popover = panel()!
    expect(popover.className).toBe('cal-popover')
    expect(popover.parentElement).toBe(document.body)
    expect(container!.contains(popover)).toBe(false)
    expect(popover.style.left).toMatch(/^-?\d+(\.\d+)?px$/)
    expect(popover.style.bottom).toMatch(/^-?\d+(\.\d+)?px$/)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(panel()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('is a bottom sheet <dialog> on a phone', async () => {
    phone = true
    await open()
    const sheet = document.querySelector('dialog.cal-sheet')!
    expect(sheet.hasAttribute('open')).toBe(true)
    expect(sheet.querySelector('[data-calendar]')).not.toBeNull()
    expect(document.querySelector('.cal-popover')).toBeNull()
    expect(sheet.querySelector('[data-day="2026-09-22"]')).not.toBeNull()
    act(() => { (sheet as HTMLDialogElement).close() })
    expect(document.querySelector('dialog.cal-sheet[open]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
})

describe('the calendar\'s foot', () => {
  it('explains both dots and the grey days, and a Today link picks today', async () => {
    const picks = await open()
    expect([...document.querySelectorAll('.cal-legend-line')].map((l) => l.textContent))
      .toEqual(['Left dot · sleep in your usual range outside it', 'Right dot · steps reached your usual below it'])
    expect(document.querySelector('.cal-note')!.textContent).toBe('Grey days have no data')
    const today = document.querySelector<HTMLButtonElement>('.cal-today')!
    expect(today.textContent).toBe('Today')
    act(() => { today.click() })
    expect(picks).toEqual([TODAY])
    expect(panel()).toBeNull()
  })
})
