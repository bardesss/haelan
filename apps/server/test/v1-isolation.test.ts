import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// Started here with the three cases the guard itself needs; Task 9 turns this into the
// enumerated suite over every versioned route.
describe('the versioned surface is isolated per person', () => {
  it('answers 401 without a session, before it looks at the person at all', async () => {
    harness = await withServer()
    await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02',
    })
    expect(response.statusCode).toBe(401)
  })

  // The one that matters. An account owns exactly one person today, so this is the tautology guard:
  // it proves the path segment is checked rather than decorative.
  it('answers 403 for a person the session does not own', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const response = await harness.app.inject({
      method: 'GET', url: `/api/v1/p/${other.personId}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { kind: 'forbidden' } })
  })

  it('answers 404 for a person id that does not exist, rather than 403', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/nobody/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(404)
  })
})
