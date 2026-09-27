// @vitest-environment happy-dom
// happy-dom: the button is clicked, the popover's keys pressed and the sheet's dialog events fired
// for real, with showModal, close and matchMedia stubbed the way glance-calendar.test.tsx stubs them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LogButton } from '../src/components/logPanel/LogButton.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'
import type { Session } from '../src/auth/session.js'
import type { GlanceLog } from '../src/data/useGlance.js'
import { glanceLog } from './glanceFixture.js'
import { flush } from './flush.js'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  birthDate: null, sex: null, sleepTargetMinutes: 480, sleepUseBaseline: true, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const TODAY = '2026-09-23'

let container: HTMLDivElement | null = null
let root: Root | null = null
let client: QueryClient | null = null
let seen: string[] = []
let writes: { method: string, url: string, body: unknown }[] = []
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
  window.history.replaceState(null, '', '/?day=2026-09-20')
  seen = []
  writes = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    seen.push(url)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(url.includes('/quick-log/day/') ? glanceLog() : {}),
      { status: 200, headers: { 'content-type': 'application/json' } })
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
  client = null
  restoreFetch?.()
  HTMLDialogElement.prototype.showModal = realShowModal
  HTMLDialogElement.prototype.close = realClose
  window.matchMedia = realMatchMedia
  window.history.replaceState(null, '', '/')
})

/** Mounts the button on `shownDay` with that day's log, the way the Dashboard hands it the glance's;
 *  `log: null` mounts it with none, as the Dashboard does while it loads the day it names. */
function mount(shownDay = TODAY, log: GlanceLog | null = glanceLog()): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root!.render(
      <I18nProvider lng="en"><QueryClientProvider client={client!}>
        <LogButton shownDay={shownDay} today={TODAY} log={log ?? undefined} />
      </QueryClientProvider></I18nProvider>,
    )
  })
}

const trigger = () => container!.querySelector<HTMLButtonElement>('button.log-btn')!
const popover = () => document.querySelector<HTMLElement>('.log-popover')
const sheet = () => document.querySelector<HTMLDialogElement>('dialog.log-sheet')
const title = () => document.querySelector('[data-log-panel] h2')?.textContent
const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`[data-log-panel] button[aria-label="${label}"]`)!
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-log-panel] button')].find((b) => b.textContent === text)!
const dayRequests = () => seen.filter((url) => url.includes('/quick-log/day/'))
const settle = () => flush(client!, () => document.body.innerHTML)
function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}
function open(): void { act(() => { trigger().click() }) }
const note = () => document.querySelector<HTMLTextAreaElement>('[data-log-panel] textarea')!
function type(el: HTMLTextAreaElement, value: string): void {
  // Through the prototype's setter, so React reads the input event as a change (log-panel.test.tsx).
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const noteWrites = () => writes.filter((write) => write.url.includes('/notes/'))

describe('the Log button', () => {
  it('is a labelled button that says it opens a popover', () => {
    mount()
    expect(trigger().className).toBe('button button-primary log-btn')
    expect(trigger().textContent).toBe('Log')
    expect(trigger().getAttribute('aria-label')).toBeNull()
    expect(trigger().getAttribute('aria-haspopup')).toBe('true')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('the popover, on a desktop', () => {
  it('opens under the button, named by the panel\'s title, with focus in the title row', () => {
    mount()
    open()
    const layer = popover()!
    expect(layer.parentElement).toBe(document.body)
    expect(layer.getAttribute('role')).toBe('dialog')
    expect(layer.hasAttribute('data-log-panel')).toBe(true)
    expect(title()).toBe('Log for today')
    expect(document.getElementById(layer.getAttribute('aria-labelledby')!)?.textContent).toBe('Log for today')
    expect(layer.style.left).toMatch(/^-?\d+(\.\d+)?px$/)
    expect(layer.style.bottom).toMatch(/^-?\d+(\.\d+)?px$/)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(byLabel('Previous day'))
    // Today's log came with the glance, so the panel draws it without asking.
    expect(dayRequests()).toEqual([])
  })

  it('puts its left edge on the button\'s, just under it', () => {
    const real = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const box = this.classList.contains('log-btn') ? { left: 500, right: 560, top: 20, bottom: 56 }
        : this.classList.contains('log-popover') ? { left: 0, right: 380, top: 0, bottom: 400 }
          : { left: 0, right: 0, top: 0, bottom: 0 }
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect
    }
    try {
      mount()
      open()
      expect(popover()!.style.left).toBe('500px')
      // Six pixels under the button's bottom edge, as a distance from the viewport's bottom.
      expect(popover()!.style.bottom).toBe(`${window.innerHeight - 56 - 6 - 400}px`)
    } finally { HTMLElement.prototype.getBoundingClientRect = real }
  })

  it('closes on Escape, putting focus back on the button', () => {
    mount()
    open()
    const event = key(byLabel('Previous day'), 'Escape')
    expect(popover()).toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
  })

  it('leaves an Escape something else already claimed alone', () => {
    const claim = (event: KeyboardEvent) => { if (event.key === 'Escape') event.preventDefault() }
    document.addEventListener('keydown', claim)
    try {
      mount()
      open()
      key(document.body, 'Escape')
      expect(popover()).not.toBeNull()
    } finally { document.removeEventListener('keydown', claim) }
  })

  it('closes on a press outside, but not on one inside or on the button', () => {
    mount()
    open()
    act(() => { popover()!.querySelector('h2')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    act(() => { trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(popover()).not.toBeNull()
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(popover()).toBeNull()
  })

  it('is its own toggle: a second press on the button closes it', () => {
    mount()
    open()
    open()
    expect(popover()).toBeNull()
  })

  it('steps its own day with ‹, asking for that day, and leaves the dashboard\'s day where it was', async () => {
    mount()
    open()
    act(() => { byLabel('Previous day').click() })
    await settle()
    expect(title()).toBe('Log for yesterday')
    expect(dayRequests()).toEqual(['/api/v1/p/p1/quick-log/day/2026-09-22'])
    expect(window.location.search).toBe('?day=2026-09-20')
  })

  it('opens on a past day the dashboard shows, drawn from that day\'s log without a request', () => {
    mount('2026-09-20', glanceLog({ note: 'A long day' }))
    open()
    expect(title()).toBe('Log for Sun, Sep 20')
    expect(document.querySelector<HTMLTextAreaElement>('[data-log-panel] textarea')!.value).toBe('A long day')
    expect(dayRequests()).toEqual([])
  })

  it('seeds only the dashboard\'s own day: stepping away and back asks for the day stepped to', async () => {
    mount('2026-09-20', glanceLog({ note: 'A long day' }))
    open()
    act(() => { byLabel('Next day').click() })
    await settle()
    expect(dayRequests()).toEqual(['/api/v1/p/p1/quick-log/day/2026-09-21'])
    expect(document.querySelector<HTMLTextAreaElement>('[data-log-panel] textarea')!.value).toBe('')
  })

  it('asks for the shown day when it has no log for it (the dashboard still loading that day)', async () => {
    mount('2026-09-20', null)
    open()
    await settle()
    expect(dayRequests()).toEqual(['/api/v1/p/p1/quick-log/day/2026-09-20'])
  })

  it('an Escape inside the chip editor ends the edit and leaves the popover open', () => {
    mount()
    open()
    act(() => { byText('Edit').click() })
    const item = document.querySelector<HTMLElement>('[data-log-panel] .log-edit-item')!
    key(item, 'Escape')
    expect(popover()).not.toBeNull()
    expect(document.querySelector('.log-editor')).toBeNull()
    // The next Escape, with the editor gone, is the popover's.
    key(byText('Edit'), 'Escape')
    expect(popover()).toBeNull()
  })

  it('an Escape clearing a draft in the add field leaves the popover open', () => {
    mount()
    open()
    act(() => { byText('Edit').click() })
    const field = document.querySelector<HTMLInputElement>('[data-log-panel] .log-editor input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, 'sauna')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(field, 'Escape')
    expect(popover()).not.toBeNull()
    expect(document.querySelector('.log-editor')).not.toBeNull()
  })

  it('Shift+Tab off the first control goes back to the button, Tab off the last closes', () => {
    mount()
    open()
    const first = byLabel('Previous day')
    const back = key(first, 'Tab', { shiftKey: true })
    expect(back.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(trigger())
    expect(popover()).not.toBeNull()
    const note = document.querySelector<HTMLTextAreaElement>('[data-log-panel] textarea')!
    act(() => { note.focus() })
    const onward = key(note, 'Tab')
    // Not claimed: the browser steps on from the button as it would with the popover shut.
    expect(onward.defaultPrevented).toBe(false)
    expect(popover()).toBeNull()
  })

  it('Tab off the button closes the popover', () => {
    mount()
    open()
    key(trigger(), 'Tab')
    expect(popover()).toBeNull()
  })
})

// Escape, a press outside and ‹ › take the panel away without the textarea ever blurring, so the
// half-typed note is saved as the panel's body unmounts, to the day it was typed on, and once.
describe('a half-typed note', () => {
  it('is saved when Escape closes the popover', async () => {
    mount()
    open()
    type(note(), 'Late dinner')
    key(note(), 'Escape')
    expect(popover()).toBeNull()
    await settle()
    expect(noteWrites()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Late dinner' } }])
  })

  it('is saved when a press outside closes the popover', async () => {
    mount()
    open()
    type(note(), 'Late dinner')
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(popover()).toBeNull()
    await settle()
    expect(noteWrites()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Late dinner' } }])
  })

  it('is saved to the day it was typed on when ‹ steps to the day before', async () => {
    mount()
    open()
    type(note(), 'Late dinner')
    act(() => { byLabel('Previous day').click() })
    await settle()
    expect(title()).toBe('Log for yesterday')
    expect(noteWrites()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Late dinner' } }])
  })

  it('is saved once when a blur already saved it and the popover then closes', async () => {
    mount()
    open()
    type(note(), 'Late dinner')
    act(() => { note().dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    key(document.body, 'Escape')
    await settle()
    expect(noteWrites()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Late dinner' } }])
  })

  it('is saved when Escape closes the phone sheet', async () => {
    phone = true
    mount()
    open()
    type(note(), 'Late dinner')
    // The browser's own Escape: an unclaimed keydown, then the dialog closing itself.
    key(note(), 'Escape')
    act(() => { sheet()!.close() })
    expect(sheet()).toBeNull()
    await settle()
    expect(noteWrites()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Late dinner' } }])
  })

  it('sends nothing when nothing was typed', async () => {
    mount()
    open()
    key(document.body, 'Escape')
    await settle()
    expect(noteWrites()).toEqual([])
  })
})

describe('the sheet, on a phone', () => {
  it('opens as a modal <dialog> with a grab bar, and the button keeps its name while its label is hidden', () => {
    phone = true
    mount()
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger().textContent).toBe('Log')
    expect(trigger().querySelector('.log-btn-label')?.textContent).toBe('Log')
    open()
    const dialog = sheet()!
    expect(dialog.hasAttribute('open')).toBe(true)
    // Outside the day navigator's role="group", as the popover is.
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.closest('[role="group"]')).toBeNull()
    expect(dialog.hasAttribute('data-log-panel')).toBe(true)
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Log for today')
    expect(dialog.querySelector('.log-grab')?.getAttribute('aria-hidden')).toBe('true')
    expect(popover()).toBeNull()
  })

  it('hides the label visually at phone width and makes the button a 44px square shaped like the arrows', () => {
    const css = readFileSync('apps/web/src/app.css', 'utf8')
    // The media block that sizes the day arrows for a finger is the one the button joins.
    const block = css.slice(css.indexOf('.day-nav-btn { min-width: 44px; }'))
    const label = /\.log-btn-label \{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(label).toMatch(/position: absolute/)
    expect(label).toMatch(/clip-path: inset\(50%\)/)
    const button = /\.log-btn \{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(button).toMatch(/width: 44px/)
    // Shaped like the day arrows beside it: no .log-btn rule anywhere gives it a radius of its own,
    // so it keeps .button's, which is what .day-nav-btn has too.
    const radii = [...css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter((rule) => /\.(log-btn|day-nav-btn)\b/.test(rule[1]!) && /border-radius/.test(rule[2]!))
    expect(radii.map((rule) => rule[1]!.trim())).toEqual([])
  })

  it('closes on its close event, a backdrop click and ✕, focus back on the button each time', () => {
    phone = true
    mount()
    open()
    act(() => { sheet()!.close() })
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    open()
    act(() => { sheet()!.click() })
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    open()
    act(() => { byLabel('Close').click() })
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  // A modal dialog makes everything outside it inert, so in a real browser the trigger cannot take
  // focus until the dialog is closed; happy-dom has no inertness, so the order itself is asserted.
  it('closes the dialog before handing focus back, on ✕ and on a backdrop click', () => {
    phone = true
    mount()
    const openAtFocus: boolean[] = []
    const realFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      if (this === trigger()) openAtFocus.push(sheet()?.open === true)
      realFocus.call(this, options)
    }
    try {
      open()
      act(() => { byLabel('Close').click() })
      expect(sheet()).toBeNull()
      open()
      act(() => { sheet()!.click() })
      expect(sheet()).toBeNull()
      expect(openAtFocus.length).toBeGreaterThan(0)
      expect(openAtFocus.every((wasOpen) => !wasOpen)).toBe(true)
    } finally { HTMLElement.prototype.focus = realFocus }
  })

  it('a click inside the sheet is not a backdrop click', () => {
    phone = true
    mount()
    open()
    act(() => { sheet()!.querySelector('h2')!.click() })
    expect(sheet()).not.toBeNull()
  })

  it('an Escape inside the chip editor cancels the dialog\'s cancel, so the sheet stays up', () => {
    phone = true
    mount()
    open()
    act(() => { byText('Edit').click() })
    key(document.querySelector('[data-log-panel] .log-edit-item')!, 'Escape')
    // The browser's own close request follows the keydown.
    const cancel = new Event('cancel', { cancelable: true })
    act(() => { sheet()!.dispatchEvent(cancel) })
    expect(cancel.defaultPrevented).toBe(true)
    expect(sheet()!.hasAttribute('open')).toBe(true)
    expect(document.querySelector('.log-editor')).toBeNull()
  })

  it('drops a claimed Escape no cancel followed, so a later back gesture still closes the sheet', async () => {
    phone = true
    mount()
    open()
    act(() => { byText('Edit').click() })
    // A browser that honours the claim fires no cancel at all.
    key(document.querySelector('[data-log-panel] .log-edit-item')!, 'Escape')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    const back = new Event('cancel', { cancelable: true })
    act(() => { sheet()!.dispatchEvent(back) })
    expect(back.defaultPrevented).toBe(false)
  })

  it('an Escape nobody inside claimed lets the dialog close, as does a close request with no key at all', () => {
    phone = true
    mount()
    open()
    key(byLabel('Previous day'), 'Escape')
    const cancel = new Event('cancel', { cancelable: true })
    act(() => { sheet()!.dispatchEvent(cancel) })
    expect(cancel.defaultPrevented).toBe(false)
    // Android's back gesture: a cancel with no keydown before it.
    const back = new Event('cancel', { cancelable: true })
    act(() => { sheet()!.dispatchEvent(back) })
    expect(back.defaultPrevented).toBe(false)
  })
})
