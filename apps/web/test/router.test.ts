import { describe, it, expect } from 'vitest'
import { matchRoute, routeParams, withQuery } from '../src/router.js'

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

describe('route parameters', () => {
  it('matches a parameter segment and reports it', () => {
    expect(matchRoute('/p/:personId/sleep', '/p/abc/sleep')).toBe(true)
    expect(routeParams('/p/:personId/sleep', '/p/abc/sleep')).toEqual({ personId: 'abc' })
  })

  it('does not match when the segment count differs', () => {
    expect(matchRoute('/p/:personId/sleep', '/p/abc')).toBe(false)
    expect(routeParams('/p/:personId/sleep', '/p/abc')).toBeNull()
  })

  it('ignores the query string, as the exact matcher already does', () => {
    expect(routeParams('/p/:personId/sleep', '/p/abc/sleep?range=week')).toEqual({ personId: 'abc' })
  })
})

describe('withQuery', () => {
  it('adds a key without disturbing the others', () => {
    expect(withQuery('/sleep?range=week', { date: '2026-08-22' })).toBe('/sleep?range=week&date=2026-08-22')
  })

  it('replaces a key rather than appending a second copy', () => {
    expect(withQuery('/sleep?range=week', { range: 'month' })).toBe('/sleep?range=month')
  })

  // Null removes, so a control row can clear a filter without building the string itself.
  it('removes a key when the value is null', () => {
    expect(withQuery('/sleep?range=week&date=2026-08-22', { date: null })).toBe('/sleep?range=week')
  })

  it('drops the question mark when nothing is left', () => {
    expect(withQuery('/sleep?range=week', { range: null })).toBe('/sleep')
  })
})
