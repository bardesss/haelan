// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Shell } from '../src/Shell.js'
import { I18nProvider } from '../src/i18n/index.js'
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

const TOKEN = 'TOKEN123'

/**
 * Stands in for both real routes (apps/server/src/routes/invite.ts) plus /api/auth/me, the way
 * mountMembersApi in settings-members.test.tsx stands in for /api/members: this test needs the
 * whole POST-then-refetch-the-session round trip, not a single seeded query, so a fetch stub is
 * what exercises it rather than queryClient.setQueryData.
 *
 * `info: null` is a token nothing resolves to (the invalid-invite scenario); an unmatched request
 * of any other kind (every one of Dashboard's own data queries, once a redemption succeeds and
 * Shell falls through to the signed-in app) answers 404 as well, so each of those cards renders
 * its own error state instead of hanging on the real network or requiring this test to know
 * Dashboard's endpoints.
 */
function mockInviteApi(info: { displayName: string, timezone: string } | null): { restore: () => void } {
  let redeemed: { personId: string, username: string } | null = null
  const original = globalThis.fetch
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  const notFound = () =>
    json(404, { error: { kind: 'not_found', code: 'no_such_invite', message: 'this invite is no longer valid' } })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (method === 'GET' && url.endsWith(`/api/invite/${TOKEN}`)) {
      return info === null ? notFound() : json(200, info)
    }
    if (method === 'POST' && url.endsWith(`/api/invite/${TOKEN}`)) {
      if (info === null) return notFound()
      const body = JSON.parse(String(init?.body)) as { username: string, password: string }
      redeemed = { personId: 'new-person', username: body.username }
      return json(201, redeemed)
    }
    if (method === 'GET' && url.endsWith('/api/auth/me')) {
      if (redeemed === null || info === null) {
        return json(401, { error: { kind: 'unauthorized', code: 'no_session', message: 'no session' } })
      }
      return json(200, {
        personId: redeemed.personId, displayName: info.displayName,
        username: redeemed.username, isAdmin: false, timezone: info.timezone,
      })
    }
    return notFound()
  }) as typeof fetch

  return { restore: () => { globalThis.fetch = original } }
}

// Native setter, not `input.value =`: the latter goes through React's own tracked setter and
// leaves onChange never firing (settings-members.test.tsx's own type() carries the same note).
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function mountShell(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Shell /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

describe('the invite screen', () => {
  it('renders for an invite path even with no session', async () => {
    window.history.replaceState(null, '', `/invite/${TOKEN}`)
    const api = mockInviteApi({ displayName: 'Bob', timezone: 'Europe/Amsterdam' })
    const client = mountShell()

    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(container!.textContent).toContain('Join as Bob')
    // The sign-in screen's own h1 (signIn.title, "Sign in") is the tell for the regression this
    // guards: an invite path with no session used to fall straight through to Shell's unauthorized
    // branch and show that screen instead of this one.
    expect(container!.querySelector('h1')?.textContent).not.toBe('Sign in')
  })

  it('says one thing for an invalid token', async () => {
    window.history.replaceState(null, '', `/invite/${TOKEN}`)
    const api = mockInviteApi(null)
    const client = mountShell()

    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(container!.textContent).toContain('This invite is no longer valid')
  })

  it('signs the member in on success', async () => {
    window.history.replaceState(null, '', `/invite/${TOKEN}`)
    const api = mockInviteApi({ displayName: 'Bob', timezone: 'Europe/Amsterdam' })
    const client = mountShell()
    await flush(client, () => container!.innerHTML)

    const inputs = [...container!.querySelectorAll('input')] as HTMLInputElement[]
    type(inputs[0]!, 'bob')
    type(inputs[1]!, 'a good long password')
    click(container!.querySelector('button[type="submit"]')!)

    await flush(client, () => container!.innerHTML)
    api.restore()

    // Reached through Shell's own fallback (routes.tsx has no entry for '/invite/:token', so
    // Shell's `ROUTES.find(...) ?? ROUTES[0]!` renders Dashboard), not through any navigation this
    // screen performs itself: RedeemInvite only ever invalidates the session query, exactly as the
    // task brief asks, and it is that invalidated-then-refetched session succeeding that flips
    // Shell's `signedIn` and lets the signed-in app take over on the next render.
    expect(container!.textContent).toContain('Dashboard')
  })
})
