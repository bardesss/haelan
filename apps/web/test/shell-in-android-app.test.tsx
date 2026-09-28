// @vitest-environment happy-dom
//
// happy-dom because the phone header only exists once useIsPhone's matchMedia has answered, and
// static markup has no window to ask: it would only ever see the desktop rail.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { Shell } from '../src/Shell.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'

// A stand-in page, for the reason error-boundary.test.tsx gives: what is asserted here is what
// Shell puts around the page, and a real page would bring its own requests and charts along.
vi.mock('../src/routes.js', () => ({
  ROUTES: [{ path: '/', element: 'the page itself' }],
}))

const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 HaelanAndroid/1.4.0'
const PHONE_BROWSER = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'

const PERSON: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // The status control and the data types query ask the server; nothing here is about their
  // answers, so every request stays pending rather than reaching for a server that is not there.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount({ userAgent, phone }: { userAgent: string, phone: boolean }): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone, media: query,
    addEventListener: () => {}, removeEventListener: () => {},
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Shell /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const phoneHeader = () => container!.querySelector('.top-bar')
const menuButton = () => container!.querySelector('[data-testid="rail-open"]')
const rail = () => container!.querySelector('.rail')

describe('Shell inside the Android app', () => {
  // The app's own bar is the page's header there; a second one under it put the brand on screen
  // twice and gave the page two headers.
  it('renders no phone header, no menu and no rail, only the page', () => {
    mount({ userAgent: ANDROID_APP, phone: true })
    expect(phoneHeader()).toBeNull()
    expect(menuButton()).toBeNull()
    expect(rail()).toBeNull()
    expect(container!.textContent).not.toContain('Hælan')
    expect(container!.querySelector('main.main')!.textContent).toBe('the page itself')
  })

  // Only the chrome goes: "/" and "?" still have their dialogs (rendered closed) to open, for a
  // tablet in the app with a keyboard attached.
  it('keeps the keyboard shortcuts', () => {
    mount({ userAgent: ANDROID_APP, phone: true })
    expect(container!.querySelectorAll('dialog.shortcut-dialog')).toHaveLength(2)
  })

  // A wide web view (a tablet, a phone on its side) would otherwise fall to the desktop rail.
  it('renders no rail at a wide viewport either', () => {
    mount({ userAgent: ANDROID_APP, phone: false })
    expect(rail()).toBeNull()
    expect(phoneHeader()).toBeNull()
    expect(container!.querySelector('main.main')!.textContent).toBe('the page itself')
  })
})

describe('Shell in a browser', () => {
  it('keeps the phone header with its menu and the brand on a phone', () => {
    mount({ userAgent: PHONE_BROWSER, phone: true })
    expect(phoneHeader()).not.toBeNull()
    expect(menuButton()).not.toBeNull()
    expect(phoneHeader()!.textContent).toContain('Hælan')
  })

  it('keeps the rail on a wide screen', () => {
    mount({ userAgent: PHONE_BROWSER, phone: false })
    expect(rail()).not.toBeNull()
  })
})
