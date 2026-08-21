import { describe, it, expect } from 'vitest'
import { matchRoute } from '../src/router.js'

describe('matchRoute', () => {
  it('matches an exact path', () => {
    expect(matchRoute('/setup/google', '/setup/google')).toBe(true)
    expect(matchRoute('/setup/google', '/setup/account')).toBe(false)
  })

  it('ignores a trailing slash, because a pasted URL often carries one', () => {
    expect(matchRoute('/setup/google', '/setup/google/')).toBe(true)
  })

  it('ignores the query string, which is where the callback puts its error code', () => {
    expect(matchRoute('/setup/google', '/setup/google?error=bad_state')).toBe(true)
  })

  it('does not treat a prefix as a match', () => {
    expect(matchRoute('/setup', '/setup/google')).toBe(false)
  })

  it('treats the root and the empty path as the same route', () => {
    expect(matchRoute('/', '')).toBe(true)
    expect(matchRoute('/', '/')).toBe(true)
    expect(matchRoute('/', '/setup')).toBe(false)
  })
})
