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

beforeEach(() => {
  // happy-dom has no dialog implementation; these move the open attribute the way a browser does.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  phone = false
  window.matchMedia = ((query: string) => ({
    matches: phone && query === PHONE_MEDIA_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
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
      { sourceId: 'watch', name: 'Pixel Watch 4', lastReportedDate: '2026-09-24', stale: false, choice: null },
      { sourceId: 'scale', name: 'Withings scale', lastReportedDate: '2026-09-20', stale: false, choice: null },
    ],
    ...over,
  }
}

function phoneConnection(over: Partial<StatusConnection> = {}): StatusConnection {
  return {
    kind: 'phone', lastDeliveryAtMs: NOW - 55 * 60_000, problem: null,
    devices: [{ sourceId: 'hc', name: 'Health Connect', lastReportedDate: '2026-09-23', stale: false, choice: null }],
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
let originalFetch: typeof fetch
beforeEach(() => {
  serverStatus = panel()
  runAnswer = { status: 202, body: { started: true } }
  posts = []
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push(url)
      return new Response(JSON.stringify(runAnswer.body), { status: runAnswer.status, headers: { 'content-type': 'application/json' } })
    }
    const body = url === '/api/status' ? serverStatus : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

const DATA_KEY = queryKeys.resource(PERSON.personId, 'series', { metric: 'steps' })

function mount(status: StatusPanel, lng = 'en'): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(statusKey(PERSON.personId), status)
  client.setQueryData(DATA_KEY, { points: [] })
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng={lng}>
          <div className="outside">elsewhere</div>
          <StatusControl />
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
const popover = (): HTMLElement | null => container!.querySelector('.status-popover')
const sheet = (): HTMLDialogElement | null => container!.querySelector('dialog.status-sheet')
const syncButton = (): HTMLButtonElement | null => container!.querySelector<HTMLButtonElement>('.status-sync')

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
    await pollAnswers(panel({}, { running: false }), client)
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

  it('reads a 429 as the cooldown, not a failure', async () => {
    runAnswer = { status: 429, body: { error: { kind: 'transient', code: 'cooldown', message: 'cooldown' } } }
    mount(panel())
    press(icon())
    press(syncButton()!)
    await settle()
    expect(popover()!.querySelector('.status-result')!.textContent).toBe('Synced just now')
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
    press(icon())
    expect(popover()!.querySelector('.status-result')).toBeNull()
    await pollAnswers(panel({}, { running: false, lastRowsWritten: 0, lastFinishedAtMs: Date.now() }), client)
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
    mount(panel({ connections: [google({ devices: [{ sourceId: 'scale', name: 'Withings scale', lastReportedDate: '2026-08-01', stale: true, choice: null }] })], problems: 1 }))
    press(icon())
    const row = popover()!.querySelector('.status-device')!
    expect(row.getAttribute('data-stale')).toBe('true')
    expect(row.textContent).toContain('gone quiet')
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
})
