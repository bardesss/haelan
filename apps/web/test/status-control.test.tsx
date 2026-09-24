// @vitest-environment happy-dom
//
// happy-dom, because every case here presses something and reads the DOM back: the icon is only
// the trigger, and what this file guards is what opens behind it and how it closes again.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { StatusControl } from '../src/components/StatusControl.js'
import { dayLabel } from '../src/components/StatusPanel.js'
import { navigate } from '../src/router.js'
import { statusKey } from '../src/data/useStatusPanel.js'
import type { StatusPanel, StatusConnection } from '../src/data/useStatusPanel.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'

/**
 * The status icon beside the reader's name, and the panel it opens: a popover in the rail's foot
 * on a desktop, a bottom sheet on a phone. It replaced SyncControl, whose sync button now lives
 * inside the panel, beside the Google connection it acts on.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null
// Captured so afterEach can put them back, for the reason rail-drawer.test.tsx gives: these are
// prototype methods on a global every other file in the worker shares.
const realShowModal = HTMLDialogElement.prototype.showModal
const realClose = HTMLDialogElement.prototype.close
const realMatchMedia = window.matchMedia
let phone = false
let mediaListeners = new Set<() => void>()

function crossBreakpoint(toPhone: boolean): void {
  phone = toPhone
  act(() => { for (const listener of mediaListeners) listener() })
}

beforeEach(() => {
  // happy-dom has no dialog implementation; these move the open attribute the way a browser does.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  phone = false
  mediaListeners = new Set()
  // matches is a getter and the change listeners are kept, so a test can cross the phone
  // breakpoint mid-test the way a resized window does: flip `phone`, then crossBreakpoint().
  window.matchMedia = ((query: string) => ({
    get matches() { return phone && query === PHONE_MEDIA_QUERY },
    media: query,
    addEventListener: (_type: string, listener: () => void) => { mediaListeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { mediaListeners.delete(listener) },
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  HTMLDialogElement.prototype.showModal = realShowModal
  HTMLDialogElement.prototype.close = realClose
  window.matchMedia = realMatchMedia
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const NOW = Date.now()

function google(over: Partial<StatusConnection> = {}): StatusConnection {
  return {
    kind: 'google', lastDeliveryAtMs: NOW - 7 * 60_000, problem: null,
    devices: [
      { sourceId: 'watch', name: 'Pixel Watch 4', lastReportedDate: '2026-09-24', stale: false, choice: null, metrics: [] },
      { sourceId: 'scale', name: 'Withings scale', lastReportedDate: '2026-09-20', stale: false, choice: null, metrics: [] },
    ],
    ...over,
  }
}

// A watch gone quiet, as composeStatus sends it: its routine metrics are catalogue keys, two
// sleep metrics among them that are one data type to a reader, and one key nothing names.
const QUIET_WATCH = {
  sourceId: 'watch', name: 'Pixel Watch 4', lastReportedDate: '2026-08-21', stale: true, choice: null,
  metrics: ['heart_rate', 'not_a_metric', 'sleep_asleep_minutes', 'sleep_deep_minutes', 'steps', 'vo2_max'],
}

function phoneConnection(over: Partial<StatusConnection> = {}): StatusConnection {
  return {
    kind: 'phone', lastDeliveryAtMs: NOW - 55 * 60_000, problem: null,
    devices: [{ sourceId: 'hc', name: 'Health Connect', lastReportedDate: '2026-09-23', stale: false, choice: null, metrics: [] }],
    ...over,
  }
}

function panel(over: Partial<StatusPanel> = {}, sync: Partial<NonNullable<StatusPanel['sync']>> = {}): StatusPanel {
  return {
    connections: [google(), phoneConnection()],
    sync: { running: false, lastFinishedAtMs: NOW - 7 * 60_000, lastRowsWritten: 12, lastFailed: 0, cooldownRemainingMs: 0, ...sync },
    problems: 0,
    hiddenDevices: 0,
    ...over,
  }
}

// The server, for the whole of each test: /api/status answers serverStatus, the run route answers
// runAnswer, and anything else an empty object.
let serverStatus: StatusPanel = panel()
let runAnswer: { status: number, body: unknown } = { status: 202, body: { started: true } }
let posts: string[] = []
let statusGets = 0
let originalFetch: typeof fetch
beforeEach(() => {
  serverStatus = panel()
  runAnswer = { status: 202, body: { started: true } }
  posts = []
  statusGets = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push(url)
      return new Response(JSON.stringify(runAnswer.body), { status: runAnswer.status, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/status') statusGets += 1
    const body = url === '/api/status' ? serverStatus : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

const DATA_KEY = queryKeys.resource(PERSON.personId, 'series', { metric: 'steps' })

// Mounted where the shell puts it, inside the rail's foot, so the portal test below can prove the
// popover is NOT inside the rail - the rail is a scroll container, and anything absolutely placed
// inside it is clipped at its edge.
function mount(status: StatusPanel, lng = 'en', railClass = 'rail'): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(statusKey(PERSON.personId), status)
  client.setQueryData(DATA_KEY, { points: [] })
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng={lng}>
          <div className="outside">elsewhere</div>
          <nav className={railClass}><div className="rail-foot"><StatusControl /></div></nav>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

async function pollAnswers(status: StatusPanel, client: QueryClient): Promise<void> {
  await act(async () => {
    client.setQueryData(statusKey(PERSON.personId), status)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

const icon = (): HTMLButtonElement => container!.querySelector<HTMLButtonElement>('.status-button')!
// The document, not the container: the popover is portalled to document.body.
const popover = (): HTMLElement | null => document.querySelector('.status-popover')
const sheet = (): HTMLDialogElement | null => container!.querySelector('dialog.status-sheet')
const syncButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.status-sync')

// One act() per event, for the reason rail-menu.test.tsx's press() gives: a single act() batches
// the sequence, so a pointerdown that tore the popover down would still let the click land.
function press(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  act(() => { el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) })
  act(() => { el.click() })
}

describe('the status icon', () => {
  it('says all sources are up to date, with no dot, when nothing is wrong', () => {
    mount(panel())
    expect(icon().getAttribute('aria-label')).toBe('Status: all sources up to date')
    expect(container!.querySelector('.status-dot')).toBeNull()
  })

  it('says syncing while a run goes, and marks itself running', () => {
    mount(panel({}, { running: true }))
    expect(icon().getAttribute('aria-label')).toBe('Status: syncing')
    expect(icon().getAttribute('data-running')).toBe('true')
  })

  it('counts the problems, and draws the dot only when there are some', () => {
    mount(panel({ problems: 2 }))
    expect(icon().getAttribute('aria-label')).toBe('Status: 2 problems')
    expect(container!.querySelector('.status-button .status-dot')).not.toBeNull()
  })

  // Mounted in the shell whether or not its panel is open, because this is the one place that
  // turns a finished run into fresh charts; the panel being shut must not switch that off.
  it('refreshes the person\'s data when a run ends, with the panel closed', async () => {
    const client = mount(panel({}, { running: true }))
    expect(popover()).toBeNull()
    await pollAnswers(panel({}, { running: false, lastFinishedAtMs: Date.now() }), client)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
  })
})

describe('the popover, on a desktop', () => {
  it('opens on a press, with one section per connection and the devices in order', () => {
    mount(panel())
    expect(popover()).toBeNull()
    expect(icon().getAttribute('aria-haspopup')).toBe('true')
    expect(icon().getAttribute('aria-expanded')).toBe('false')
    press(icon())
    expect(popover()).not.toBeNull()
    expect(popover()!.getAttribute('role')).toBe('dialog')
    expect(icon().getAttribute('aria-expanded')).toBe('true')
    const sections = [...popover()!.querySelectorAll('.status-connection')]
    expect(sections).toHaveLength(2)
    expect(sections[0]!.querySelector('.status-connection-name')!.textContent).toBe('Google Health')
    expect(sections[0]!.querySelector('.status-connection-when')!.textContent).toBe('synced 7 minutes ago')
    expect(sections[1]!.querySelector('.status-connection-name')!.textContent).toBe('Phone app')
    expect(sections[1]!.querySelector('.status-connection-when')!.textContent).toBe('uploaded 55 minutes ago')
    const names = [...popover()!.querySelectorAll('.status-device')].map((row) => row.firstElementChild!.textContent)
    expect(names).toEqual(['Pixel Watch 4', 'Withings scale', 'Health Connect'])
  })

  it('moves focus into the popover when it opens', () => {
    mount(panel())
    press(icon())
    expect(popover()!.contains(document.activeElement)).toBe(true)
  })

  // A panel left closed for a while is refreshed only by the five-minute idle poll; opening it is
  // when a reader actually wants the current answer, not whatever that poll last landed on.
  it('refetches the status when the panel opens', async () => {
    mount(panel())
    await settle()
    statusGets = 0
    press(icon())
    await settle()
    expect(statusGets).toBeGreaterThan(0)
  })

  // preventDefault for the reason the person menu gives: inside the phone drawer a layer on top of
  // a <dialog> must not let one Escape close both.
  it('closes on Escape, claims the key, and hands focus back to the icon', () => {
    mount(panel())
    press(icon())
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { document.dispatchEvent(event) })
    expect(popover()).toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(icon())
  })

  /**
   * Portalled to the end of the body, the popover sits last in the document's tab order, far from
   * the icon that opened it: Tab past its last control left the rail entirely for whatever came
   * after it in the body, and Shift+Tab from its first control went to the page's last control
   * rather than back to the icon. The keyboard order is restored as if the popover followed the
   * icon. happy-dom performs no default Tab navigation, so these assert what the handler does to
   * focus and to the event; the browser's own step past the icon is what the default does next.
   */
  function tab(from: HTMLElement, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    act(() => { from.dispatchEvent(event) })
    return event
  }
  const focusables = (): HTMLElement[] => [...popover()!.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')]

  it('goes back to the icon on Shift+Tab from the popover\'s first control', () => {
    mount(panel())
    press(icon())
    const first = focusables()[0]!
    expect(document.activeElement).toBe(first)
    const event = tab(first, true)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(icon())
    expect(popover()).not.toBeNull()
  })

  it('goes into the popover on Tab from the icon while it is open', () => {
    mount(panel())
    press(icon())
    act(() => { icon().focus() })
    const event = tab(icon())
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(focusables()[0])
  })

  // Closes, and hands focus to the icon WITHOUT claiming the key: the browser's default Tab then
  // runs from the icon and lands on whatever follows it in the rail, which is where Tab past the
  // popover's end would go if the popover really sat after the icon.
  it('closes on Tab past its last control, leaving the default Tab to step on from the icon', () => {
    mount(panel())
    press(icon())
    const last = focusables().at(-1)!
    act(() => { last.focus() })
    const event = tab(last)
    expect(event.defaultPrevented).toBe(false)
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(icon())
  })

  // Focus can sit on the popover box itself (a click on its padding does that, tabIndex -1). Its
  // controls follow it in the document, so a Tab from there is not its end and must not close it.
  it('does not close on Tab from the popover box itself while it holds controls', () => {
    mount(panel())
    press(icon())
    act(() => { popover()!.focus() })
    const event = tab(popover()!)
    expect(event.defaultPrevented).toBe(false)
    expect(popover()).not.toBeNull()
    const back = tab(popover()!, true)
    expect(back.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(icon())
  })

  it('leaves Tab between its own controls to the browser', () => {
    mount(panel())
    press(icon())
    const [first] = focusables()
    expect(focusables().length).toBeGreaterThan(1)
    const event = tab(first!)
    expect(event.defaultPrevented).toBe(false)
    expect(popover()).not.toBeNull()
    expect(document.activeElement).toBe(first)
  })

  it('closes on a press outside it', () => {
    mount(panel())
    press(icon())
    act(() => { container!.querySelector('.outside')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(popover()).toBeNull()
  })

  it('stays open for a press inside it', () => {
    mount(panel())
    press(icon())
    act(() => { popover()!.querySelector('.status-device')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(popover()).not.toBeNull()
  })
})

describe('the sheet, on a phone', () => {
  it('opens a modal dialog rather than the popover', () => {
    phone = true
    mount(panel())
    expect(icon().getAttribute('aria-haspopup')).toBe('dialog')
    expect(sheet()!.hasAttribute('open')).toBe(false)
    press(icon())
    expect(sheet()!.hasAttribute('open')).toBe(true)
    expect(popover()).toBeNull()
    expect(sheet()!.querySelectorAll('.status-connection')).toHaveLength(2)
  })

  it('closes from its own close button and gives focus back to the icon', () => {
    phone = true
    mount(panel())
    press(icon())
    press(container!.querySelector<HTMLButtonElement>('[data-testid="status-sheet-close"]')!)
    expect(sheet()!.hasAttribute('open')).toBe(false)
    expect(document.activeElement).toBe(icon())
  })
})

describe('the sync button', () => {
  it('is disabled while a run goes, and says so', () => {
    mount(panel({}, { running: true }))
    press(icon())
    expect(syncButton()!.disabled).toBe(true)
    expect(syncButton()!.textContent).toBe('Syncing…')
  })

  // The server refuses a second run inside a minute of the last one; the button says the true
  // thing about that minute rather than offering a click that will be refused.
  it('is disabled during the cooldown, reading "Synced just now"', () => {
    mount(panel({}, { cooldownRemainingMs: 30_000 }))
    press(icon())
    expect(syncButton()!.disabled).toBe(true)
    expect(syncButton()!.textContent).toBe('Synced just now')
  })

  it('posts a run when pressed', async () => {
    mount(panel())
    press(icon())
    expect(syncButton()!.disabled).toBe(false)
    expect(syncButton()!.textContent).toBe('Sync now')
    press(syncButton()!)
    await settle()
    expect(posts).toEqual(['/api/sync/run'])
  })

  // A 429 is the server's cooldown, which the button already says ("Synced just now", disabled)
  // once useRunSync's onError has re-read the status. A result line saying it too put the same
  // three words in the panel twice, one under the other; the button carries it alone.
  it('reads a 429 as the cooldown, said once, on the button', async () => {
    runAnswer = { status: 429, body: { error: { kind: 'transient', code: 'cooldown', message: 'cooldown' } } }
    mount(panel())
    press(icon())
    // The open's own refetch settles first, on the idle answer, so the press below is offered;
    // only then does the server start answering with the cooldown the 429 implies.
    await settle()
    serverStatus = panel({}, { cooldownRemainingMs: 55_000 })
    press(syncButton()!)
    await settle()
    expect(syncButton()!.textContent).toBe('Synced just now')
    expect(syncButton()!.disabled).toBe(true)
    expect(popover()!.querySelector('.status-result')).toBeNull()
    expect(popover()!.textContent!.split('Synced just now')).toHaveLength(2)
  })

  it('reads a 409 as a run already going', async () => {
    runAnswer = { status: 409, body: { error: { kind: 'transient', code: 'already_running', message: 'busy' } } }
    mount(panel())
    press(icon())
    press(syncButton()!)
    await settle()
    expect(popover()!.querySelector('.status-result')!.textContent).toBe('A sync is already running.')
  })

  it('says nothing new arrived when the run it watched wrote no rows', async () => {
    const client = mount(panel({}, { running: true }))
    // Opening the panel refetches (see 'refetches the status when the panel opens' above), so the
    // server's own answer is set to the finished state before the press that opens it - a value
    // set only after press() would lose a race against that refetch's own in-flight read.
    serverStatus = panel({}, { running: false, lastRowsWritten: 0, lastFinishedAtMs: Date.now() })
    press(icon())
    expect(popover()!.querySelector('.status-result')).toBeNull()
    await pollAnswers(serverStatus, client)
    expect(popover()!.querySelector('.status-result')!.textContent).toBe('Nothing new.')
  })

  // A result line on a panel that saw no run would be describing somebody else's sync from an
  // hour ago as if it had just happened.
  it('says nothing about a run it never saw', () => {
    mount(panel({}, { lastRowsWritten: 0 }))
    press(icon())
    expect(popover()!.querySelector('.status-result')).toBeNull()
  })
})

describe('the panel content', () => {
  it('shows a revoked Google connection\'s problem, and no sync button', () => {
    mount(panel({ connections: [google({ problem: 'revoked' })], sync: null, problems: 1 }))
    press(icon())
    expect(popover()!.querySelector('.status-problem')!.textContent)
      .toBe('Google access was withdrawn. Connect again under Account.')
    expect(syncButton()).toBeNull()
  })

  it('marks a stale device', () => {
    mount(panel({ connections: [google({ devices: [{ sourceId: 'scale', name: 'Withings scale', lastReportedDate: '2026-08-01', stale: true, choice: null, metrics: [] }] })], problems: 1 }))
    press(icon())
    const row = popover()!.querySelector('.status-device')!
    expect(row.getAttribute('data-stale')).toBe('true')
    // Since when, in the words, not only on a hover title a phone never shows. The year appears
    // only once the test clock has left 2026, which is dayLabel's own rule, not this row's.
    expect(row.children[1]!.textContent).toMatch(/^gone quiet since Aug 1(, 2026)?$/)
  })

  // The panel is the one place a quiet source is announced since the cards' triangles and the
  // control row's line went, so its row has to say what they said: which data stopped arriving.
  it('names what a stale device stopped sending, after its gone-quiet text', () => {
    mount(panel({ connections: [google({ devices: [QUIET_WATCH] })], problems: 1 }))
    press(icon())
    const row = popover()!.querySelector('.status-device')!
    // Read in the order a reader meets it: the device, that it went quiet, then what stopped.
    const [name, quiet, metrics, ...rest] = [...row.children].map((child) => child.textContent)
    expect(rest).toEqual([])
    expect(name).toBe('Pixel Watch 4')
    expect(quiet).toMatch(/^gone quiet since Aug 21(, 2026)?$/)
    expect(metrics).toBe('Heart rate (continuous), sleep, steps, VO2 max')
  })

  it('leaves a metric the catalogue has no name for out, and prints no line when none has one', () => {
    const unnamed = { ...QUIET_WATCH, sourceId: 'odd', name: 'Odd device', metrics: ['not_a_metric', 'also_unknown'] }
    mount(panel({ connections: [google({ devices: [QUIET_WATCH, unnamed] })], problems: 2 }))
    press(icon())
    const [watch, odd] = [...popover()!.querySelectorAll('.status-device')]
    expect(watch!.textContent).not.toContain('not_a_metric')
    expect(odd!.querySelector('.status-device-metrics')).toBeNull()
    expect(odd!.children).toHaveLength(2)
  })

  it('lists nothing under a device that is still reporting', () => {
    mount(panel({ connections: [google({ devices: [{ ...QUIET_WATCH, stale: false, lastReportedDate: '2026-09-24' }] })] }))
    press(icon())
    expect(popover()!.querySelector('.status-device-metrics')).toBeNull()
  })

  it('counts hidden sources and links to where they are chosen', () => {
    mount(panel({ hiddenDevices: 3 }))
    press(icon())
    const foot = popover()!.querySelector('.status-foot')!
    expect(foot.textContent).toContain('3 sources hidden')
    const link = foot.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/account#sources')
    expect(link.textContent).toBe('Choose sources…')
  })

  // The link changes no route when the reader is already on /account (useRoute leaves the
  // fragment out), so the route effect cannot be what closes the panel after it; the click is.
  it('closes when its link is followed, even with the route unchanged', () => {
    const before = window.location.pathname + window.location.search + window.location.hash
    window.history.replaceState(null, '', '/account')
    try {
      mount(panel())
      press(icon())
      press(popover()!.querySelector<HTMLAnchorElement>('.status-foot a')!)
      expect(popover()).toBeNull()
      expect(window.location.pathname + window.location.hash).toBe('/account#sources')
    } finally {
      window.history.replaceState(null, '', before)
    }
  })

  it('leaves the hidden count out when nothing is hidden', () => {
    mount(panel())
    press(icon())
    expect(popover()!.querySelector('.status-foot')!.textContent).not.toContain('hidden')
  })

  it('says so when nothing is connected', () => {
    mount(panel({ connections: [], sync: null }))
    press(icon())
    expect(popover()!.textContent).toContain('Nothing is connected yet.')
  })
})

describe('in Dutch', () => {
  it('reads naturally on the sync button, idle and just after a run', () => {
    mount(panel(), 'nl')
    press(icon())
    expect(syncButton()!.textContent).toBe('Nu synchroniseren')
    expect(popover()!.querySelector('.status-connection-when')!.textContent).toBe('gesynchroniseerd 7 minuten geleden')
    act(() => { root!.unmount() })
    root = createRoot(container!)
    mount(panel({}, { cooldownRemainingMs: 20_000 }), 'nl')
    press(icon())
    expect(syncButton()!.textContent).toBe('Net gesynchroniseerd')
    expect(icon().getAttribute('aria-label')).toBe('Status: alle bronnen zijn bijgewerkt')
  })

  it('names what a stale device stopped sending in Dutch, sorted and lowered the Dutch way', () => {
    mount(panel({ connections: [google({ devices: [QUIET_WATCH] })], problems: 1 }), 'nl')
    press(icon())
    const row = popover()!.querySelector('.status-device')!
    const [name, quiet, metrics, ...rest] = [...row.children].map((child) => child.textContent)
    expect(rest).toEqual([])
    expect(name).toBe('Pixel Watch 4')
    expect(quiet).toMatch(/^stilgevallen sinds 21 aug( 2026)?$/)
    expect(metrics).toBe('Hartslag (doorlopend), slaap, stappen, VO2 max')
  })

  it('says nothing is connected rather than all up to date, with no connections at all', () => {
    mount(panel({ connections: [], sync: null }), 'nl')
    expect(icon().getAttribute('aria-label')).toBe('Status: nog niets gekoppeld')
  })
})

describe('with nothing connected', () => {
  // "All sources up to date" about a household with no sources is a claim about nothing.
  it('says so on the icon', () => {
    mount(panel({ connections: [], sync: null }))
    expect(icon().getAttribute('aria-label')).toBe('Status: nothing connected yet')
  })
})

/**
 * Where the popover goes. The rail is a scroll container (overflow-y: auto, which makes overflow-x
 * compute to auto as well), so a 20rem popover absolutely placed inside it was clipped at the
 * rail's edge: about 40px of it visible and a sideways scrollbar on the rail, and nothing at all on
 * a collapsed one. It is portalled to document.body and placed with position: fixed from the
 * icon's own rectangle instead. happy-dom does no layout, so the rectangles are stubbed; the
 * numbers asserted are the arithmetic, and the real geometry is checked in a browser.
 */
describe('the popover\'s placement', () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
  }
  function stubRects(trigger: DOMRect, foot: DOMRect, rail: DOMRect = rect(0, 0, 186, 768)): void {
    icon().getBoundingClientRect = () => trigger
    ;(container!.querySelector('.rail-foot') as HTMLElement).getBoundingClientRect = () => foot
    ;(container!.querySelector('.rail') as HTMLElement).getBoundingClientRect = () => rail
  }

  it('renders outside the rail, fixed, above the icon and aligned with the rail foot', () => {
    mount(panel())
    stubRects(rect(150, 700, 30, 30), rect(12, 690, 162, 60))
    press(icon())
    expect(container!.querySelector('.rail .status-popover')).toBeNull()
    expect(popover()!.parentElement).toBe(document.body)
    expect(popover()!.style.left).toBe('12px')
    expect(popover()!.style.bottom).toBe(`${window.innerHeight - 700 + 6}px`)
  })

  // Past the rail's edge, not the icon's: measured in Chromium, trigger.right + 6 put the popover
  // over the 60px strip's last 10px, because the icon sits inside the strip's padding.
  it('opens to the right of a collapsed rail, bottom-aligned with the icon', () => {
    mount(panel(), 'en', 'rail rail-collapsed')
    stubRects(rect(15, 700, 30, 30), rect(8, 640, 44, 100), rect(0, 0, 60, 768))
    press(icon())
    expect(popover()!.style.left).toBe(`${60 + 6}px`)
    expect(popover()!.style.bottom).toBe(`${window.innerHeight - 730}px`)
  })

  it('places itself again when the window is resized', () => {
    mount(panel())
    stubRects(rect(150, 700, 30, 30), rect(12, 690, 162, 60))
    press(icon())
    stubRects(rect(150, 500, 30, 30), rect(20, 490, 162, 60))
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(popover()!.style.left).toBe('20px')
    expect(popover()!.style.bottom).toBe(`${window.innerHeight - 500 + 6}px`)
  })

  // The popover's height is its content's, and the content grows after it opens: the open's own
  // refetch lands, a result line appears under the Sync button. Placed only on open and on a
  // window resize, a popover that grew past the room above the icon on a short window kept the
  // bottom it was given while short, and its top ran off the viewport - the clamp in placementFor
  // only works on a height it has been told about.
  it('places itself again when its own content grows', () => {
    const observers: Array<{ callback: ResizeObserverCallback, targets: Element[] }> = []
    const realResizeObserver = window.ResizeObserver
    window.ResizeObserver = class {
      readonly entry: { callback: ResizeObserverCallback, targets: Element[] }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] }
        observers.push(this.entry)
      }
      observe(target: Element) { this.entry.targets.push(target) }
      unobserve() {}
      disconnect() { this.entry.targets = [] }
    } as unknown as typeof ResizeObserver
    try {
      mount(panel())
      stubRects(rect(150, 700, 30, 30), rect(12, 690, 162, 60))
      press(icon())
      expect(popover()!.style.bottom).toBe(`${window.innerHeight - 700 + 6}px`)
      const watching = observers.find((o) => o.targets.includes(popover()!))
      expect(watching).toBeDefined()
      // Taller than the whole window less the gap: the clamp has to pin its top instead.
      popover()!.getBoundingClientRect = () => rect(12, 0, 320, window.innerHeight - 20)
      act(() => { watching!.callback([], {} as ResizeObserver) })
      expect(popover()!.style.bottom).toBe(`${20 - 6}px`)
    } finally {
      window.ResizeObserver = realResizeObserver
    }
  })

  // Portalled, it is no longer inside the wrapper, so the outside-press test has to count it as
  // inside explicitly - or a press on the Sync button would close the popover before its click.
  it('still counts a press inside the portalled popover as inside', () => {
    mount(panel())
    press(icon())
    press(syncButton()!)
    expect(popover()).not.toBeNull()
  })
})

describe('closing', () => {
  it('closes when the route changes elsewhere', () => {
    const before = window.location.pathname + window.location.search + window.location.hash
    try {
      mount(panel())
      press(icon())
      expect(popover()).not.toBeNull()
      act(() => { navigate('/sleep') })
      expect(popover()).toBeNull()
    } finally {
      window.history.replaceState(null, '', before)
    }
  })

  // The sheet's focus-return effect ran whenever isPhone changed, and on a phone with the panel
  // closed it read as "the sheet just closed": narrowing a window into phone width moved focus
  // off whatever the reader was typing in and onto this icon. Only a close hands focus back.
  it('leaves focus alone when the window narrows into phone width with the panel closed', () => {
    mount(panel())
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    try {
      elsewhere.focus()
      crossBreakpoint(true)
      expect(document.activeElement).toBe(elsewhere)
      crossBreakpoint(false)
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it('returns focus to the icon when the sheet is closed by the browser', () => {
    phone = true
    mount(panel())
    press(icon())
    // What Escape or an Android back gesture does: the dialog closes itself and says so with a
    // close event, without React having asked.
    act(() => { sheet()!.close() })
    expect(sheet()!.hasAttribute('open')).toBe(false)
    expect(document.activeElement).toBe(icon())
  })

  // An outcome belongs to the moment it was reported. Left in place, "A sync is already running."
  // would greet a reader opening the panel an hour later.
  it('forgets the last press\'s outcome once the panel closes', async () => {
    runAnswer = { status: 409, body: { error: { kind: 'transient', code: 'already_running', message: 'busy' } } }
    mount(panel())
    press(icon())
    press(syncButton()!)
    await settle()
    expect(popover()!.querySelector('.status-result')!.textContent).toBe('A sync is already running.')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    press(icon())
    expect(popover()!.querySelector('.status-result')).toBeNull()
  })

  it('forgets a watched run\'s result once the panel closes', async () => {
    const client = mount(panel({}, { running: true }))
    // Set before press(), for the reason the previous describe block's version of this test gives:
    // the open-panel refetch reads serverStatus synchronously as it fires.
    serverStatus = panel({}, { running: false, lastRowsWritten: 0, lastFinishedAtMs: Date.now() })
    press(icon())
    await pollAnswers(serverStatus, client)
    expect(popover()!.querySelector('.status-result')!.textContent).toBe('Nothing new.')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    press(icon())
    expect(popover()!.querySelector('.status-result')).toBeNull()
  })
})

describe('dayLabel', () => {
  it('names the year only when it is not this one', () => {
    expect(dayLabel('2026-08-01', '2026-09-24', 'en')).toBe('Aug 1')
    expect(dayLabel('2025-12-30', '2026-09-24', 'en')).toBe('Dec 30, 2025')
  })
})
