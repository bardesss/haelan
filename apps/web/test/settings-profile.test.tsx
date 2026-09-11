// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Settings } from '../src/pages/Settings.js'
import { Profile } from '../src/pages/settings/Profile.js'
import { instanceUrlKey } from '../src/data/useInstanceUrl.js'
import { membersKey } from '../src/data/useMembers.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
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

const SESSION: Session = {
  personId: 'p1', displayName: 'Robin', username: 'robin', isAdmin: true,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

function mountSection(overrides: Partial<Session> = {}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), { ...SESSION, ...overrides })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Profile /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

/**
 * The whole Settings page as a given session, so the question "is this card gated on isAdmin"
 * is asked of the page that does the gating rather than of the card. Every sibling section's own
 * query is seeded for settings-members.test.tsx's reason: an unseeded query reaches the real
 * network in this environment.
 */
function mountSettingsAs(overrides: Partial<Session>): void {
  const session: Session = { ...SESSION, ...overrides }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), session)
  client.setQueryData(sourceNamesKey(session.personId), { items: [] })
  client.setQueryData(queryKeys.resource(session.personId, 'overrides'), { items: [] })
  client.setQueryData(membersKey(), { items: [] })
  client.setQueryData(instanceUrlKey(), { baseUrl: 'http://localhost:4235', redirectUri: 'http://localhost:4235/oauth/callback' })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Settings /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

// Native setter, not `input.value =`: the latter goes through React's own tracked setter and
// leaves onChange never firing, the same reason settings-members.test.tsx's own type() exists.
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

const fields = (): HTMLInputElement[] => [...container!.querySelectorAll('input')] as HTMLInputElement[]
const saveButton = (): HTMLButtonElement => container!.querySelector('form button[type="submit"]') as HTMLButtonElement
const passwordForm = (): Element => container!.querySelectorAll('form')[1]!

/**
 * Stands in for PUT /api/profile and PUT /api/profile/password. `answer` decides what each one
 * gives back, so a test can drive the refusal path without a second stub.
 */
function mockProfileApi(answer: (method: string, url: string, body: Record<string, unknown> | null) => Response): {
  restore: () => void
  requests: { method: string, url: string, body: Record<string, unknown> | null }[]
} {
  const requests: { method: string, url: string, body: Record<string, unknown> | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    requests.push({ method, url, body })
    return answer(method, url, body)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

describe('the profile section', () => {
  it('shows the session\'s own name, username and time zone', () => {
    mountSection()
    expect(fields().map((f) => f.value)).toEqual(['Robin', 'robin', 'Europe/Amsterdam', '', ''])
  })

  // Written after a catalogue key landed under the wrong section and this panel rendered
  // 'settings.profile.timezone' as its own label. Every assertion above passed while it did,
  // because they all read input values and none of them read a word of copy.
  it('renders every label as copy rather than as its own key', () => {
    mountSection()
    expect(container!.innerHTML).not.toMatch(/\bsettings\.[a-zA-Z][a-zA-Z.]*\b/)
    expect([...container!.querySelectorAll('.field .label')].map((n) => n.textContent))
      .toEqual(['Name', 'Username', 'Time zone', 'Current password', 'New password'])
  })

  it('offers nothing to save until something is actually different', () => {
    mountSection()
    expect(saveButton().disabled).toBe(true)
    type(fields()[0]!, 'Bart')
    expect(saveButton().disabled).toBe(false)
  })

  it('warns about the rebuild only once the time zone differs', () => {
    mountSection()
    expect(container!.querySelector('.profile-warning')).toBeNull()

    // A name change is free and must not drag the warning on screen with it.
    type(fields()[0]!, 'Bart')
    expect(container!.querySelector('.profile-warning')).toBeNull()

    type(fields()[2]!, 'Pacific/Auckland')
    expect(container!.querySelector('.profile-warning')?.textContent)
      .toContain('re-derived from the archive')

    // Typed back to what it already was: no rebuild is owed, so no warning.
    type(fields()[2]!, 'Europe/Amsterdam')
    expect(container!.querySelector('.profile-warning')).toBeNull()
  })

  it('sends all three fields and reports the rebuild the server actually marked', async () => {
    const api = mockProfileApi(() => json(200, {
      displayName: 'Robin', username: 'robin', timezone: 'Pacific/Auckland', rebuildPending: true,
    }))
    const client = mountSection()

    type(fields()[2]!, 'Pacific/Auckland')
    click(saveButton())
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(api.requests[0]).toMatchObject({
      method: 'PUT',
      url: '/api/profile',
      body: { displayName: 'Robin', username: 'robin', timezone: 'Pacific/Auckland' },
    })
    // The server's own answer, not the panel's guess: a form that submits all three every time
    // cannot tell from its own side whether the stored zone moved.
    expect(container!.querySelector('.profile-result')?.textContent).toContain('next time haelan starts')
  })

  it('says nothing about a rebuild when the server says none is pending', async () => {
    const api = mockProfileApi(() => json(200, {
      displayName: 'Bart', username: 'robin', timezone: 'Europe/Amsterdam', rebuildPending: false,
    }))
    const client = mountSection()

    type(fields()[0]!, 'Bart')
    click(saveButton())
    await flush(client, () => container!.innerHTML)
    api.restore()

    const result = container!.querySelector('.profile-result')?.textContent ?? ''
    expect(result).toBe('Saved.')
    expect(result).not.toContain('haelan starts')
  })

  it('shows the instance\'s own sentence when a username is refused', async () => {
    const api = mockProfileApi(() => json(400, {
      error: { kind: 'config', code: 'config', message: 'username bob is already taken' },
    }))
    const client = mountSection()

    type(fields()[1]!, 'bob')
    click(saveButton())
    await flush(client, () => container!.innerHTML)
    api.restore()

    // The message names what is taken, which is the only part that tells the reader what to type
    // instead; a caption of this panel's own invention would throw it away.
    expect(container!.querySelector('.field-error')?.textContent).toContain('username bob is already taken')
  })
})

describe('changing your own password', () => {
  it('sends the current one alongside the new one', async () => {
    const api = mockProfileApi(() => new Response(null, { status: 204 }))
    const client = mountSection()

    type(fields()[3]!, 'a good long password')
    type(fields()[4]!, 'an even better password')
    click(passwordForm().querySelector('button[type="submit"]')!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(api.requests[0]).toMatchObject({
      method: 'PUT',
      url: '/api/profile/password',
      body: { currentPassword: 'a good long password', newPassword: 'an even better password' },
    })
    expect(container!.querySelector('.profile-result')?.textContent).toContain('still signed in')
    // Cleared on success, so neither password is left sitting in a field on a shared screen.
    expect([fields()[3]!.value, fields()[4]!.value]).toEqual(['', ''])
  })

  it('names the wrong current password rather than echoing a bare refusal', async () => {
    const api = mockProfileApi(() => json(403, {
      error: { kind: 'forbidden', code: 'wrong_password', message: 'that is not your current password' },
    }))
    const client = mountSection()

    type(fields()[3]!, 'not my password')
    type(fields()[4]!, 'an even better password')
    click(passwordForm().querySelector('button[type="submit"]')!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(container!.querySelector('.field-error')?.textContent).toBe('That is not your current password.')
    // Still in the field, because the next thing the reader does is correct it.
    expect(fields()[3]!.value).toBe('not my password')
  })

  it('hides both password fields from the screen', () => {
    mountSection()
    expect([fields()[3]!.type, fields()[4]!.type]).toEqual(['password', 'password'])
  })
})

describe('where the card is mounted', () => {
  it('renders for a member who is not an admin, unlike every section below it', () => {
    mountSettingsAs({ isAdmin: false })
    expect(container!.textContent).toContain('Your account')
    // The gated sections stay gated; this card is the only one a member can use.
    expect(container!.textContent).not.toContain('Members')
    expect(container!.textContent).not.toContain('Instance address')
  })

  it('renders for an admin too', () => {
    mountSettingsAs({ isAdmin: true })
    expect(container!.textContent).toContain('Your account')
    expect(container!.textContent).toContain('Members')
  })
})
