import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { signState, verifyState, STATE_TTL_MS } from '../src/oauth/state.ts'

const key = randomBytes(32)

describe('the state parameter', () => {
  it('round trips the person it was issued for', () => {
    const token = signState(key, { personId: 'p1', issuedAtMs: 1000 })
    expect(verifyState(key, token, 2000)).toEqual({ personId: 'p1', issuedAtMs: 1000 })
  })

  it('rejects a token signed with a different key', () => {
    const token = signState(randomBytes(32), { personId: 'p1', issuedAtMs: 1000 })
    expect(verifyState(key, token, 2000)).toBeNull()
  })

  it('rejects a tampered payload, which is the whole reason it is signed', () => {
    const token = signState(key, { personId: 'p1', issuedAtMs: 1000 })
    const [payload, signature] = token.split('.')
    const swapped = `${Buffer.from(JSON.stringify({ personId: 'p2', issuedAtMs: 1000 })).toString('base64url')}.${signature}`
    expect(payload).not.toBe('')
    expect(verifyState(key, swapped, 2000)).toBeNull()
  })

  it('rejects a token past its lifetime, so an old consent link cannot be replayed', () => {
    const token = signState(key, { personId: 'p1', issuedAtMs: 1000 })
    expect(verifyState(key, token, 1000 + STATE_TTL_MS + 1)).toBeNull()
  })

  it('rejects garbage without throwing, because this value arrives from the open internet', () => {
    for (const junk of ['', '.', 'a.b', 'not-base64!.x', 'a'.repeat(5000)]) {
      expect(verifyState(key, junk, 1000)).toBeNull()
    }
  })
})
