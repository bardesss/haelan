// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SetupApp } from '../src/setup/SetupApp.js'
import { navigate } from '../src/router.js'
import { pumpUntil } from './flush.js'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: false, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionStorage.clear()
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

function stubApi(opts: { state: unknown, lastError?: unknown }): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    asked.push(url)
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/setup/state') return json(opts.state)
    if (url === '/api/setup/scopes') return json({ scopes: [] })
    if (url.startsWith('/api/setup/redirect-uris?')) return json({ candidates: [] })
    if (url === '/api/setup/last-error') return json(opts.lastError ?? { code: 'none', message: '' })
    throw new Error(`unexpected request: ${url}`)
  }))
  return asked
}

function mount(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SetupApp /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const alertText = (): string => container!.querySelector('[role="alert"]')?.textContent ?? ''
const consent = { step: 'consent', companionMode: false }

describe('the Google callback refusals', () => {
  it.each([
    ['bad_state', 'expired or was already used'],
    ['wrong_person', 'someone else in this household'],
  ])('says what %s means without asking the server', async (code, phrase) => {
    navigate(`/setup/google?error=${code}`, { replace: true })
    const asked = stubApi({ state: consent })
    mount()
    await pumpUntil(() => alertText() !== '', `the ${code} alert`)
    expect(alertText()).toContain(phrase)
    expect(asked).not.toContain('/api/setup/last-error')
  })

  it('names the address Google returns to for no_session', async () => {
    navigate('/setup/google?error=no_session', { replace: true })
    const asked = stubApi({ state: consent })
    mount()
    await pumpUntil(() => alertText() !== '', 'the no_session alert')
    expect(alertText()).toContain(window.location.origin)
    expect(alertText()).toContain('sign in there')
    expect(asked).not.toContain('/api/setup/last-error')
  })

  // Characterization: this passes before the change. Mutation that makes it fail: delete the
  // getLastError fallback in SetupApp, and the alert stays empty.
  it('still reads the server message for any other code', async () => {
    navigate('/setup/google?error=exchange_failed', { replace: true })
    stubApi({
      state: consent,
      lastError: { code: 'exchange_failed', message: 'redirect_uri_mismatch: not registered' },
    })
    mount()
    await pumpUntil(() => alertText() !== '', 'the exchange_failed alert')
    expect(alertText()).toBe('redirect_uri_mismatch: not registered')
  })
})

describe('a finished instance after a failed consent', () => {
  const done = { step: 'done', companionMode: false }

  it('keeps a finished instance on the failure and offers the way back', async () => {
    navigate('/setup/google?error=exchange_failed', { replace: true })
    const asked = stubApi({
      state: done,
      lastError: { code: 'exchange_failed', message: 'redirect_uri_mismatch: not registered' },
    })
    mount()
    await pumpUntil(() => container!.textContent!.includes('redirect_uri_mismatch'), 'the failure text')
    expect(window.location.pathname).toBe('/setup/google')
    expect(container!.querySelector('a[href="/account"]')).not.toBeNull()
    expect(asked.filter((u) => u.includes('/redirect-uris') || u.includes('/scopes'))).toEqual([])
  })

  it('shows a no_session failure on a finished instance without any session read', async () => {
    navigate('/setup/google?error=no_session', { replace: true })
    const asked = stubApi({ state: done })
    mount()
    await pumpUntil(() => container!.textContent!.includes('sign in there'), 'the no_session text')
    expect(asked).toEqual(['/api/setup/state'])
  })
})
