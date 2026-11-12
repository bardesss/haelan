import { createHmac, timingSafeEqual } from 'node:crypto'

export const STATE_TTL_MS = 10 * 60_000

export interface StatePayload {
  personId: string
  issuedAtMs: number
}

export function signState(key: Buffer, payload: StatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${mac(key, encoded)}`
}

// Returns null rather than throwing for every failure, because every caller does the same
// thing with a bad state and this value arrives from whatever the browser was redirected by.
export function verifyState(key: Buffer, token: string, nowMs: number): StatePayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, signature] = parts
  if (encoded === undefined || signature === undefined || encoded === '') return null

  const expected = Buffer.from(mac(key, encoded))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload
  } catch {
    return null
  }
  if (typeof payload?.personId !== 'string' || typeof payload?.issuedAtMs !== 'number') return null
  if (payload.issuedAtMs + STATE_TTL_MS < nowMs) return null
  return payload
}

// A signed state proves this instance issued it, not that it has not been used. Replaying a
// callback URL from history must not store a grant again. In memory on purpose: a restart
// forgets spent states, but every state outlives a restart by at most STATE_TTL_MS.
export class ConsumedStates {
  #seen: Map<string, number> = new Map()

  /** True the first time `token` is offered, false on every later call. Prunes entries whose
   *  issuedAtMs + STATE_TTL_MS is before nowMs, since verifyState refuses those anyway. */
  consume(token: string, issuedAtMs: number, nowMs: number): boolean {
    for (const [seen, issued] of this.#seen) {
      if (issued + STATE_TTL_MS < nowMs) this.#seen.delete(seen)
    }
    if (this.#seen.has(token)) return false
    this.#seen.set(token, issuedAtMs)
    return true
  }
}

function mac(key: Buffer, encoded: string): string {
  return createHmac('sha256', key).update(encoded).digest('base64url')
}
