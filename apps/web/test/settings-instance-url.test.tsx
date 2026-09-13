// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { InstanceUrl } from '../src/pages/settings/InstanceUrl.js'
import { instanceUrlKey, redirectUriPreview } from '../src/data/useInstanceUrl.js'
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const ADMIN: Session = {
  personId: 'admin-1', displayName: 'Admin', username: 'admin', isAdmin: true,
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

const CURRENT = { baseUrl: 'http://localhost:4235', redirectUri: 'http://localhost:4235/oauth/callback' }

function mount(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), ADMIN)
  // Seeded rather than fetched, for the reason settings-maintenance.test.tsx's own helper gives:
  // an unseeded query reaches the real network in this environment.
  client.setQueryData(instanceUrlKey(), CURRENT)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><InstanceUrl /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

const field = (): HTMLInputElement => container!.querySelector('input.input')!
const submit = (): HTMLButtonElement => container!.querySelector('button[type="submit"]')!
// The second of the two, the current address being the first: this is the line a reader is being
// told to copy into the Google console.
const redirectShown = (): string => [...container!.querySelectorAll('code.copy-value')].at(-1)?.textContent ?? ''

function type(value: string): void {
  const input = field()
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

/**
 * Records what the PUT was actually sent, since the whole panel rests on one claim: the redirect
 * it told somebody to register is the redirect this instance will use.
 */
function mockSave(): { restore: () => void, bodies: { baseUrl: string }[] } {
  const bodies: { baseUrl: string }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (baseUrl: string) => new Response(
      JSON.stringify({ baseUrl, redirectUri: redirectUriPreview(baseUrl) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    if ((init?.method ?? 'GET') === 'PUT' && url.endsWith('/api/settings/instance-url')) {
      const body = JSON.parse(String(init?.body)) as { baseUrl: string }
      bodies.push(body)
      return json(body.baseUrl)
    }
    // The GET the mutation's own invalidation triggers. Left unanswered, the query would land in
    // its error state and the panel would render ErrorState over the result line this test is
    // about, which is what the first version of this mock did.
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/api/settings/instance-url')) {
      return json(bodies.at(-1)?.baseUrl ?? CURRENT.baseUrl)
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, bodies }
}

describe('the instance address panel', () => {
  it('warns that the redirect has to be registered before the address is saved', () => {
    mount()
    const warning = container!.querySelector('.instance-url-warning')
    // Present unconditionally, not raised after a failure: the failure this warns about never
    // arrives as a failure here. Syncing carries on as normal, and the next consent is what
    // breaks, weeks or months later, so nothing about this line is conditional on state.
    expect(warning?.textContent).toContain('before you save')
    expect(warning?.textContent).toContain('Google Cloud console')
    // Ahead of the button in document order, since a reader who has already clicked has already
    // done the thing this is warning them out of.
    const position = warning!.compareDocumentPosition(submit())
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0)
  })

  it('shows the redirect the typed address would produce, before anything is saved', () => {
    mount()
    expect(redirectShown()).toBe('http://localhost:4235/oauth/callback')
    type('https://haelan.example.com/')
    // The trailing slash is gone here and not only at the server: somebody who registers what
    // this line says has registered what the route will store.
    expect(redirectShown()).toBe('https://haelan.example.com/oauth/callback')
  })

  it('sends the address whose redirect it showed', async () => {
    const api = mockSave()
    try {
      const client = mount()
      type('https://haelan.example.com')
      const shown = redirectShown()
      act(() => { submit().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await flush(client, () => container!.innerHTML)
      expect(api.bodies).toEqual([{ baseUrl: 'https://haelan.example.com' }])
      expect(redirectUriPreview(api.bodies[0]!.baseUrl)).toBe(shown)
      expect(container!.querySelector('.instance-url-result')?.textContent)
        .toContain('https://haelan.example.com')
    } finally {
      api.restore()
    }
  })

  it('offers no save until the address would actually change', () => {
    mount()
    expect(submit().disabled).toBe(true)
    // A trailing slash typed back onto the current address changes the field and changes nothing
    // a household has to act on, so it is not a change this panel offers to save.
    type('http://localhost:4235/')
    expect(submit().disabled).toBe(true)
    type('https://haelan.example.com')
    expect(submit().disabled).toBe(false)
  })
})
