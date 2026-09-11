import { describe, expect, it } from 'vitest'
import { sessionPath } from '../src/data/useWorkoutSession.js'

describe('sessionPath', () => {
  it('builds the by-id path', () => {
    expect(sessionPath('p1', 'run1')).toBe('/api/v1/p/p1/sessions/run1')
  })

  it('encodes a session id so an id with a slash cannot forge a path segment', () => {
    // Session ids are 32 hex characters today (stableId in mapSessions.ts), so this is insurance
    // rather than a live case. Insurance that costs one function call and prevents a path
    // traversal is worth keeping.
    expect(sessionPath('p1', 'a/b')).toBe('/api/v1/p/p1/sessions/a%2Fb')
  })

  it('encodes the person id for the same reason', () => {
    expect(sessionPath('a b', 'run1')).toBe('/api/v1/p/a%20b/sessions/run1')
  })
})
