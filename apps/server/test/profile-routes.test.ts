import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

const PASSWORD = 'a good long password'

let h: Harness
let adminToken: string

beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()
  adminToken = await h.signIn()
})
afterEach(async () => { await h.cleanup() })

const authHeader = (token: string | null) => (token === null ? {} : { authorization: `Bearer ${token}` })

const saveProfile = (token: string | null, body: Record<string, unknown>) => h.app.inject({
  method: 'PUT', url: '/api/profile', headers: authHeader(token), payload: body,
})

const changePassword = (token: string | null, body: Record<string, unknown>) => h.app.inject({
  method: 'PUT', url: '/api/profile/password', headers: authHeader(token), payload: body,
})

const me = (token: string | null) => h.app.inject({
  method: 'GET', url: '/api/auth/me', headers: authHeader(token),
})

const login = (username: string, password: string) => h.app.inject({
  method: 'POST', url: '/api/auth/login', payload: { username, password },
})

const resetMemberPassword = (token: string | null, accountId: string, password: unknown) => h.app.inject({
  method: 'POST', url: `/api/members/${accountId}/password`, headers: authHeader(token), payload: { password },
})

const invite = (token: string | null, displayName: string) => h.app.inject({
  method: 'POST', url: '/api/members', headers: authHeader(token), payload: { displayName },
})

// Read straight off the store rather than through a route, because no route reports it: the
// derivation stamp is what the boot rebuild reads, and the whole claim about a timezone change is
// about that column rather than about anything a response says.
const person = (id: string) => h.app.haelan.stores.people.get(id)

describe('PUT /api/profile', () => {
  it('changes the display name and reports it back on the session', async () => {
    const response = await saveProfile(adminToken, { displayName: 'Bart' })
    expect(response.statusCode).toBe(200)
    expect(response.json().displayName).toBe('Bart')
    expect((await me(adminToken)).json().displayName).toBe('Bart')
  })

  it('lower cases a username on the way in, the same way create does', async () => {
    // The pair the unique index exists to stop coexisting. Asserted on the stored value, not on
    // the request, because the index is only real if the column itself never sees the capital B.
    const response = await saveProfile(adminToken, { username: 'RoBin2' })
    expect(response.statusCode).toBe(200)
    expect(response.json().username).toBe('robin2')
    expect((await me(adminToken)).json().username).toBe('robin2')
    // And the capitalised spelling signs in, because it is normalised on the way in too.
    expect((await login('ROBIN2', PASSWORD)).statusCode).toBe(200)
  })

  it('refuses a username another account already holds, and changes nothing', async () => {
    await h.addPerson({ id: 'p-bob', displayName: 'Bob', username: 'bob' })

    const response = await saveProfile(adminToken, { username: 'BOB' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect(response.json().error.message).toContain('already taken')

    // Not merely "the response said no": the admin still answers to their old name, and bob's
    // account is still bob's.
    expect((await me(adminToken)).json().username).toBe('robin')
    expect((await login('bob', PASSWORD)).statusCode).toBe(200)
  })

  it('lets an account re-save its own name, which is not a collision', async () => {
    expect((await saveProfile(adminToken, { username: 'Robin' })).statusCode).toBe(200)
    expect((await me(adminToken)).json().username).toBe('robin')
  })

  it('keeps the caller signed in across a rename', async () => {
    // The failure this exists for is locking yourself out by renaming yourself, so the assertion
    // is on the token that was already in hand rather than on a fresh sign-in.
    const before = await me(adminToken)
    expect(before.statusCode).toBe(200)

    expect((await saveProfile(adminToken, { username: 'renamed' })).statusCode).toBe(200)

    const after = await me(adminToken)
    expect(after.statusCode).toBe(200)
    expect(after.json().username).toBe('renamed')
    // Same account, not merely some account: a session that had silently become somebody else's
    // would answer 200 here too.
    expect(after.json().personId).toBe(before.json().personId)
  })

  it('refuses a timezone Intl does not know', async () => {
    const response = await saveProfile(adminToken, { timezone: 'Mars/Olympus' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect(person('p1')!.timezone).toBe('Europe/Amsterdam')
  })

  it('moves the day boundary and marks the derived rows for a rebuild', async () => {
    // Asserted before as well as after. A stamp that was already null would make the "now null"
    // assertion below true without this route doing anything at all.
    expect(person('p1')!.builtDerivationVersion).toEqual(expect.any(Number))

    const response = await saveProfile(adminToken, { timezone: 'Pacific/Auckland' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ timezone: 'Pacific/Auckland', rebuildPending: true })

    expect(person('p1')!.timezone).toBe('Pacific/Auckland')
    expect(person('p1')!.builtDerivationVersion).toBeNull()
    // Tier 1 did not go stale: samples carry no local date, so the mapping stamp is left alone.
    expect(person('p1')!.builtMappingVersion).toEqual(expect.any(Number))
  })

  it('does not mark a rebuild when the timezone is sent back unchanged', async () => {
    const stampBefore = person('p1')!.builtDerivationVersion
    expect(stampBefore).toEqual(expect.any(Number))

    // The whole form, exactly as a panel saving an edited name would send it: the zone is present
    // and identical, which must not cost this person every derived row they have.
    const response = await saveProfile(adminToken, {
      displayName: 'Robin', username: 'robin', timezone: 'Europe/Amsterdam',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().rebuildPending).toBe(false)
    expect(person('p1')!.builtDerivationVersion).toBe(stampBefore)
  })

  it('refuses a name of only spaces without touching the stored one', async () => {
    const response = await saveProfile(adminToken, { displayName: '   ' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect(person('p1')!.displayName).toBe('Robin')
  })

  it('refuses a username sent as something other than text', async () => {
    const response = await saveProfile(adminToken, { username: 42 })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })
})

describe('PUT /api/profile birthday and sex', () => {
  it('saves both', async () => {
    await saveProfile(adminToken, { birthDate: '1985-03-04', sex: 'male' })
    expect((await me(adminToken)).json()).toMatchObject({ birthDate: '1985-03-04', sex: 'male' })
  })

  // Three different answers, not two. Absent is "leave it", null is "clear it", a string is "set
  // it" - and the existing three fields on this route have only the first and last, because a name
  // and a timezone cannot be cleared. These two can.
  it('treats an absent field as untouched and an explicit null as a clear', async () => {
    await saveProfile(adminToken, { birthDate: '1985-03-04', sex: 'male' })
    await saveProfile(adminToken, { displayName: 'Sam' })
    expect((await me(adminToken)).json().birthDate).toBe('1985-03-04')

    await saveProfile(adminToken, { birthDate: null })
    expect((await me(adminToken)).json().birthDate).toBeNull()
    expect((await me(adminToken)).json().sex).toBe('male')
  })

  it('refuses a birthday that is not a date', async () => {
    const response = await saveProfile(adminToken, { birthDate: '4 March 1985' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('refuses a sex outside the two the coefficient table has', async () => {
    const response = await saveProfile(adminToken, { sex: 'other' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('refuses a birthDate sent as something other than text or null', async () => {
    const response = await saveProfile(adminToken, { birthDate: 42 })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // Unlike the timezone on the same route, which clears the derivation stamp and costs a rebuild.
  it('reports no pending rebuild', async () => {
    const response = await saveProfile(adminToken, { birthDate: '1985-03-04' })
    expect(response.statusCode).toBe(200)
    expect(response.json().rebuildPending).toBe(false)
    expect(person('p1')!.builtDerivationVersion).toEqual(expect.any(Number))
  })

  it('carries both on /api/auth/me for a person who has set neither', async () => {
    expect((await me(adminToken)).json()).toMatchObject({ birthDate: null, sex: null })
  })
})

describe('PUT /api/profile/password', () => {
  const NEW_PASSWORD = 'an even better password'

  it('replaces the password once the current one is given', async () => {
    const response = await changePassword(adminToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(response.statusCode).toBe(204)

    expect((await login('robin', NEW_PASSWORD)).statusCode).toBe(200)
    // The old one has to stop working, or nothing was replaced.
    expect((await login('robin', PASSWORD)).statusCode).toBe(401)
  })

  it('leaves the session alive, so nobody is signed out by changing their own password', async () => {
    await changePassword(adminToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect((await me(adminToken)).statusCode).toBe(200)
  })

  it('refuses a wrong current password and leaves the old one working', async () => {
    const response = await changePassword(adminToken, { currentPassword: 'not my password', newPassword: NEW_PASSWORD })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatchObject({ kind: 'forbidden', code: 'wrong_password' })

    // Both halves, because only the pair says nothing happened: the new password must not work,
    // and the old one must still.
    expect((await login('robin', NEW_PASSWORD)).statusCode).toBe(401)
    expect((await login('robin', PASSWORD)).statusCode).toBe(200)
  })

  it('does not count a wrong current password towards a lockout', async () => {
    // Ten failures is what AccountStore.login locks on. A signed-in person fumbling their own
    // current password must not be able to lock themselves out of their own account.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await changePassword(adminToken, { currentPassword: 'wrong', newPassword: NEW_PASSWORD })).statusCode).toBe(403)
    }
    expect((await login('robin', PASSWORD)).statusCode).toBe(200)
  })

  it('refuses a new password under the length floor', async () => {
    const response = await changePassword(adminToken, { currentPassword: PASSWORD, newPassword: 'short' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect((await login('robin', PASSWORD)).statusCode).toBe(200)
  })

  it('refuses a request with no session', async () => {
    const response = await changePassword(null, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(response.statusCode).toBe(401)
    expect((await login('robin', PASSWORD)).statusCode).toBe(200)
  })
})

describe('POST /api/members/:accountId/password', () => {
  const RESET = 'the admin chose this one'
  let bobAccountId: string

  beforeEach(async () => {
    const bob = await h.addPerson({ id: 'p-bob', displayName: 'Bob', username: 'bob' })
    bobAccountId = bob.accountId
  })

  it('lets an admin set another member\'s password without knowing the old one', async () => {
    const response = await resetMemberPassword(adminToken, bobAccountId, RESET)
    expect(response.statusCode).toBe(204)

    expect((await login('bob', RESET)).statusCode).toBe(200)
    expect((await login('bob', PASSWORD)).statusCode).toBe(401)
  })

  it('is refused to a member who is not an admin', async () => {
    const bobToken = await h.signIn('bob', PASSWORD)
    const response = await resetMemberPassword(bobToken, 'a1', RESET)
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatchObject({ kind: 'forbidden', code: 'not_admin' })
    // The admin's own password is untouched, which is the thing the refusal is protecting.
    expect((await login('robin', PASSWORD)).statusCode).toBe(200)
  })

  it('refuses an unknown account', async () => {
    const response = await resetMemberPassword(adminToken, 'a-nonexistent', RESET)
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('no_such_account')
  })

  it('refuses a password under the length floor and leaves the member\'s own working', async () => {
    const response = await resetMemberPassword(adminToken, bobAccountId, 'short')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect((await login('bob', PASSWORD)).statusCode).toBe(200)
  })

  it('grants no reach into that member\'s data', async () => {
    await resetMemberPassword(adminToken, bobAccountId, RESET)
    // The named exception is exactly one thing wide. requirePerson still answers the admin's
    // session 'not_your_person' for bob's rows, which is what keeps this a recovery door rather
    // than a role hierarchy.
    const response = await h.app.inject({
      method: 'GET', url: '/api/v1/p/p-bob/sources', headers: authHeader(adminToken),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('not_your_person')
  })
})

describe('an invite takes the timezone of the admin who sent it', () => {
  it('creates the person in the inviting admin\'s zone, with none in the body', async () => {
    // Moved off the harness default first, so a person landing on 'Europe/Amsterdam' cannot pass
    // this by coincidence.
    expect((await saveProfile(adminToken, { timezone: 'Pacific/Auckland' })).statusCode).toBe(200)

    const created = (await invite(adminToken, 'Bob')).json()
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(person(created.personId)!.timezone).toBe('Pacific/Auckland')
  })

  it('shows it on the invite the member opens, and lets them change it once they are in', async () => {
    await saveProfile(adminToken, { timezone: 'Pacific/Auckland' })
    const created = (await invite(adminToken, 'Bob')).json()

    const opened = await h.app.inject({ method: 'GET', url: `/api/invite/${created.token}` })
    expect(opened.json()).toEqual({ displayName: 'Bob', timezone: 'Pacific/Auckland' })

    const redeemed = await h.app.inject({
      method: 'POST', url: `/api/invite/${created.token}`, payload: { username: 'bob', password: PASSWORD },
    })
    expect(redeemed.statusCode).toBe(201)
    const bobToken = await h.signIn('bob', PASSWORD)

    // The whole point of dropping it from the invite: the guess is correctable by the person it
    // is about, which is what it never was before.
    expect((await saveProfile(bobToken, { timezone: 'Europe/Lisbon' })).statusCode).toBe(200)
    expect(person(created.personId)!.timezone).toBe('Europe/Lisbon')
  })
})
