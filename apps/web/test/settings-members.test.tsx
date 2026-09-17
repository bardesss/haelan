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
import { Members } from '../src/pages/settings/Members.js'
import { instanceUrlKey } from '../src/data/useInstanceUrl.js'
import { membersKey } from '../src/data/useMembers.js'
import type { MemberRow } from '../src/data/useMembers.js'
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

const ADMIN: Session = {
  personId: 'admin-1', displayName: 'Admin', username: 'admin', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// Every field MemberRow needs, defaulted so a test only names what it is actually asserting on.
// accountId/inviteId follow from state rather than being named separately in most calls, the same
// way the route itself derives them (apps/server/src/routes/members.ts's own GET handler): an
// invited row has no account yet, an active or disabled row has no pending invite left to revoke.
let memberCounter = 0
function member(overrides: Partial<MemberRow> & { displayName: string }): MemberRow {
  memberCounter += 1
  const state = overrides.state ?? 'active'
  return {
    personId: `person-${memberCounter}`,
    timezone: 'Europe/Amsterdam',
    accountId: state === 'invited' ? null : `account-${memberCounter}`,
    username: null,
    isAdmin: false,
    state,
    inviteId: state === 'invited' ? `invite-${memberCounter}` : null,
    // The two figures the row shows beside the name, defaulted to "nothing to say" so a case that
    // is not about activity renders the same row it always did: never signed in, and - for a row
    // with an account - a sync with nothing due, which prints no sync half at all.
    lastLoginAtMs: null,
    sync: state === 'invited' ? null : { oldestSuccessAtMs: null, neverSucceeded: 0, failing: 0, due: 0 },
    ...overrides,
  }
}

/**
 * Mounts the Members section alone, with the members list pre-seeded under the same key
 * useMembers/every mutation's own invalidation shares (membersKey). An unseeded query would reach
 * the real network in this environment rather than merely running slow -- see
 * apps/web/test/control-row.test.tsx's own comment on withQuery -- so every test here seeds it,
 * including the one seeding an empty list.
 */
function mountSection(items: MemberRow[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), ADMIN)
  client.setQueryData(membersKey(), { items })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Members /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

/**
 * Mounts the whole Settings page as a given session, the way a real admin or a real non-admin
 * member would see it. OverrideList, SourceNames and InstanceUrl mount alongside Members here
 * regardless of which this test cares about, so each of their own queries needs seeding too, or
 * they reach the real network the same way an unseeded members query would.
 */
function mountSettingsAs(overrides: Partial<Session>): void {
  const session: Session = { ...ADMIN, ...overrides }
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

const rowNames = (): string[] =>
  [...container!.querySelectorAll('.member-name')].map((n) => n.textContent ?? '')

const rowStates = (): string[] =>
  [...container!.querySelectorAll('.member-state')].map((n) => n.textContent ?? '')

const rowActivity = (): string[] =>
  [...container!.querySelectorAll('.member-activity')].map((n) => n.textContent ?? '')

// Every control the list draws, in order, by its label. A count alone said "three buttons" and
// would have gone on saying it if the wrong three had been drawn.
const buttonLabels = (): string[] =>
  [...container!.querySelectorAll('.member-actions button')].map((n) => n.textContent ?? '')

const linkText = (): string =>
  container!.querySelector('.copy-value')?.textContent ?? ''

// Native setter, not `input.value =`: the latter goes through React's own tracked setter and
// leaves onChange never firing, the same reason settings-source-names.test.tsx's own type() exists.
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/**
 * Stands in for the real routes (apps/server/src/routes/members.ts): GET answers whatever the
 * last invite left behind, and POST answers the one shape this suite cares about -- a token that
 * exists nowhere else, because that is the entire point of Task 5's invite flow. Neither the
 * account state routes nor the revoke route are exercised here, so mocking only these two is
 * enough for the invite test that needs the network at all.
 */
function mockMembersApi(initialItems: MemberRow[]): {
  restore: () => void
  requests: { method: string, url: string, body: Record<string, unknown> | null }[]
} {
  let items = initialItems
  const requests: { method: string, url: string, body: Record<string, unknown> | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    requests.push({ method, url, body })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (method === 'GET' && url.endsWith('/api/members')) return json(200, { items })
    if (method === 'POST' && url.endsWith('/api/members')) {
      const invited = member({ displayName: String(body!['displayName']), state: 'invited' })
      items = [...items, invited]
      return json(200, { personId: invited.personId, inviteId: invited.inviteId, token: 'TOKEN123', expiresAtMs: 1_000 })
    }
    // The password reset answers 204 with no body, exactly as the route does: there is nothing to
    // report back about a password, and the panel's own result line is what says it landed.
    if (method === 'POST' && url.endsWith('/password')) return new Response(null, { status: 204 })
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

describe('the members section', () => {
  it('lists each member with their state', () => {
    mountSection([
      member({ displayName: 'Ann', username: 'ann', state: 'active', isAdmin: true }),
      member({ displayName: 'Bob', username: null, state: 'invited' }),
      member({ displayName: 'Cat', username: 'cat', state: 'disabled' }),
      // Revoked or expired, either way: no account and no pending invite left. Its own honest
      // label, and no control at all - it draws neither the revoke button (no inviteId) nor
      // suspend or restore (no accountId).
      member({ displayName: 'Dee', username: null, state: 'expired', accountId: null, inviteId: null }),
    ])
    expect(rowNames()).toEqual(['Ann', 'Bob', 'Cat', 'Dee'])
    expect(rowStates()).toEqual(['Active', 'Invited', 'Suspended', 'Invite expired'])
    // Five, not three: reset password sits beside suspend on Ann and beside restore on Cat, since
    // a forgotten password has nothing to do with whether an account is suspended. Bob has an
    // invite and no account, so he gets revoke alone, and Dee has neither.
    expect(buttonLabels()).toEqual([
      'Suspend', 'Reset password', 'Revoke invite', 'Restore', 'Reset password',
    ])
  })

  it('offers no reset on the viewer\'s own row', () => {
    mountSection([
      member({ displayName: 'Admin', personId: ADMIN.personId, username: 'admin', state: 'active', isAdmin: true }),
    ])
    // The admin's own password goes through the Profile card, which asks for the current one.
    // Reaching it through the reset door would make that question optional for the one person who
    // can open the door.
    expect(buttonLabels()).toEqual([])
  })

  it('sends the typed password to the reset route and says whose it was', async () => {
    const api = mockMembersApi([])
    const client = mountSection([
      member({ displayName: 'Cat', username: 'cat', state: 'active', accountId: 'account-cat' }),
    ])

    click(container!.querySelector('.member-actions button:last-child')!)
    const field = container!.querySelector('.member-reset input') as HTMLInputElement
    // A password field, so a member standing beside the admin hears it rather than reads it.
    expect(field.type).toBe('password')
    type(field, 'a replacement password')
    click(container!.querySelector('.member-reset button[type="submit"]')!)

    await flush(client, () => container!.innerHTML)
    api.restore()

    const post = api.requests.find((r) => r.url.endsWith('/password'))
    expect(post).toMatchObject({
      method: 'POST',
      url: '/api/members/account-cat/password',
      body: { password: 'a replacement password' },
    })
    expect(container!.querySelector('.member-reset-result')?.textContent).toContain('Cat')
    // The form closes on success, so the password is not left sitting in a field on screen.
    expect(container!.querySelector('.member-reset')).toBeNull()
  })

  it('says so when there is nobody else in the household', () => {
    mountSection([])
    expect(container!.textContent).toContain('No other members')
  })

  // The one behaviour this whole task exists to get right: the token is rendered straight from
  // the mutation's own result, never round tripped through a cache entry, and the reader is told
  // in as many words that this is the only time they will ever see it.
  it('shows the invite link once, with the warning', async () => {
    const api = mockMembersApi([])
    const client = mountSection([])

    click(container!.querySelector('.form-actions button')!)

    // One field. The timezone the invited person lands in is the inviting admin's own, so there
    // is nothing here to guess on their behalf any more.
    const inputs = [...container!.querySelectorAll('input')] as HTMLInputElement[]
    expect(inputs).toHaveLength(1)
    // Copy, not a raw key: the caption that replaced the field is the one thing telling the admin
    // where the new member's day boundary is about to come from.
    expect(container!.textContent).toContain('starts in your own time zone')
    expect(container!.innerHTML).not.toMatch(/\bsettings\.[a-zA-Z][a-zA-Z.]*\b/)
    type(inputs[0]!, 'New Person')
    click(container!.querySelector('button[type="submit"]')!)

    await flush(client, () => container!.innerHTML)
    api.restore()

    const post = api.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/members'))
    expect(post?.body).toEqual({ displayName: 'New Person' })
    expect(linkText()).toBe(`${window.location.origin}/invite/TOKEN123`)
    expect(container!.textContent).toContain('This link is shown once')
    // INVITE_TTL_MS is why an expiry exists at all; the copy stating it is what this asserts,
    // not the exact formatted instant, which is locale and machine timezone dependent.
    expect(container!.textContent).toContain('This link expires on')
    // The server keeps only a hash of the token, so a copy of it sitting in the query cache would
    // be a copy of a credential meant to exist in exactly one place: on screen, once. Serialising
    // every cache entry (not just membersKey()) catches a future onSuccess that starts stashing
    // the mutation result anywhere, not only the one spot this test happens to look at today.
    const cacheDump = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))
    expect(cacheDump).not.toContain('TOKEN123')
  })

  it('is not rendered at all for a non-admin', () => {
    mountSettingsAs({ isAdmin: false })
    expect(container!.textContent).not.toContain('Members')
  })

  it('is rendered for an admin', () => {
    mountSettingsAs({ isAdmin: true })
    expect(container!.textContent).toContain('Members')
  })
})

/**
 * What the row says about a person beyond their name.
 *
 * The card showed three of the eight fields the route already sent, so nothing on it said who the
 * admin was - invisible in a one-person household, and the first thing anybody wants to know in
 * any other. These hold the three additions: the admin mark, the sign-in figure, and the sync
 * floor with its failure count.
 *
 * The relative wording ("2 days ago") comes from Intl and is not asserted verbatim: what matters
 * is which figure is named and that an absent one is left out rather than filled in.
 */
describe('what a member row says', () => {
  const HOUR = 3_600_000
  const now = Date.now()

  it('marks the admin, which nothing on this card used to say', () => {
    mountSection([member({ displayName: 'Ann', isAdmin: true }), member({ displayName: 'Bob' })])
    const marks = [...container!.querySelectorAll('.member-admin')].map((n) => n.textContent)
    expect(marks).toEqual(['Admin'])
    // On Ann's row, not merely somewhere on the card.
    expect(container!.querySelectorAll('.member-row')[0]!.querySelector('.member-admin')).not.toBeNull()
  })

  it('shows the username the route has been sending all along', () => {
    mountSection([member({ displayName: 'Ann', username: 'ann' })])
    expect(container!.querySelector('.member-username')!.textContent).toBe('ann')
  })

  it('names when they signed in, and says so plainly when they never have', () => {
    mountSection([
      member({ displayName: 'Ann', lastLoginAtMs: now - 2 * HOUR }),
      member({ displayName: 'Bob' }),
    ])
    expect(rowActivity()[0]).toContain('Signed in')
    expect(rowActivity()[1]).toContain('Never signed in')
  })

  // The floor is what this figure is for: a person whose steps synced a minute ago and whose sleep
  // has never run is not "synced a minute ago", and the row must not say so.
  it('reports the sync floor, and the failure count the floor cannot carry', () => {
    mountSection([
      member({ displayName: 'Ann', lastLoginAtMs: now, sync: { oldestSuccessAtMs: now - 3 * HOUR, neverSucceeded: 0, failing: 0, due: 14 } }),
      member({ displayName: 'Bob', lastLoginAtMs: now, sync: { oldestSuccessAtMs: null, neverSucceeded: 14, failing: 0, due: 14 } }),
      member({ displayName: 'Cat', lastLoginAtMs: now, sync: { oldestSuccessAtMs: now - HOUR, neverSucceeded: 0, failing: 3, due: 14 } }),
    ])
    expect(rowActivity()[0]).toContain('Synced')
    expect(rowActivity()[1]).toContain('Never synced')
    expect(rowActivity()[2]).toContain('3 of 14 data types failing')
    // Nothing failing says nothing about failures, rather than "0 of 14".
    expect(rowActivity()[0]).not.toContain('failing')
  })

  // An invited person has no account to have signed in and nothing of their own to sync, so the
  // row says neither instead of reporting two absences as if they were findings.
  it('leaves the line empty for a row with no account behind it', () => {
    mountSection([member({ displayName: 'Bob', state: 'invited' })])
    expect(rowActivity()).toEqual([''])
  })
})
