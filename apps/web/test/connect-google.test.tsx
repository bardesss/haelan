// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { ConnectGoogle } from '../src/auth/ConnectGoogle.js'

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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * Seeds the session directly on the QueryClient rather than leaving it to fetch: an unmocked
 * fetch to /api/auth/me would be a real network call in this environment, not merely a slow one
 * (control-row.test.tsx's own withQuery carries the same reasoning). ConnectGoogle reads nothing
 * else off the query client, so the session is the only key this test ever needs to seed.
 */
function mountWith(session: Partial<Session>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), { ...PERSON, ...session })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><ConnectGoogle /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

function link(): HTMLAnchorElement | null {
  return container!.querySelector('a')
}

function warningText(): string | null {
  // .connect-warning, not .form-error: ConnectGoogle.tsx's address warning has its own class now
  // (app.css), since this card holds no form for a form-error class to describe.
  return container!.querySelector('.connect-warning')?.textContent ?? null
}

describe('the connect control', () => {
  it('renders nothing for a connected person', () => {
    mountWith({ connected: true, baseUrl: 'http://localhost:4235' })
    expect(container!.textContent).toBe('')
  })

  it('offers consent when the origin matches the instance address', () => {
    mountWith({ connected: false, baseUrl: window.location.origin })
    expect(link()!.getAttribute('href')).toBe('/oauth/start')
    expect(warningText()).toBeNull()
  })

  // Before consent, not after: redirect_uri_mismatch arrives once access has already been
  // granted, which is the worst moment to learn the address was wrong.
  it('warns when the browser cannot receive the redirect', () => {
    mountWith({ connected: false, baseUrl: 'http://some-other-host:4235' })
    expect(warningText())
      .toBe('Google will send you back to http://some-other-host:4235, which is not the address you are using. Consent will fail. Open haelan at http://some-other-host:4235, or ask whoever set this up for a Tailscale or proxy address.')
  })

  it('still offers the link when it warns, rather than blocking', () => {
    mountWith({ connected: false, baseUrl: 'http://some-other-host:4235' })
    expect(link()!.getAttribute('href')).toBe('/oauth/start')
  })

  // A stored base URL carrying a trailing slash still resolves to the same origin the browser is
  // actually using, so a string comparison would warn here where consent works perfectly.
  it('does not warn over a trailing slash that still shares the browser origin', () => {
    mountWith({ connected: false, baseUrl: `${window.location.origin}/` })
    expect(warningText()).toBeNull()
  })

  // An address that fails to parse cannot receive a redirect either, so it is treated the same
  // as a genuine mismatch rather than silently skipped.
  it('warns when the stored address cannot be parsed as a URL', () => {
    mountWith({ connected: false, baseUrl: 'not a url' })
    expect(warningText()).not.toBeNull()
    expect(link()!.getAttribute('href')).toBe('/oauth/start')
  })
})
