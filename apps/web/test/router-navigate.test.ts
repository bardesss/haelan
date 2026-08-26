// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { navigate, subscribeForTest } from '../src/router.js'

beforeEach(() => { window.history.replaceState(null, '', '/dashboard') })

describe('navigate', () => {
  it('pushes by default, so the back button returns to where the reader was', () => {
    const before = window.history.length
    navigate('/dashboard?range=week')
    expect(window.location.search).toBe('?range=week')
    expect(window.history.length).toBe(before + 1)
  })

  // A reader stepping through a month should not need thirty back presses to escape it.
  it('replaces when asked, leaving the history length alone', () => {
    const before = window.history.length
    navigate('/dashboard?on=2026-08-02', { replace: true })
    expect(window.location.search).toBe('?on=2026-08-02')
    expect(window.history.length).toBe(before)
  })

  it('notifies subscribers either way, since neither pushState nor replaceState fires popstate', () => {
    let notified = 0
    const unsubscribe = subscribeForTest(() => { notified += 1 })
    navigate('/dashboard?range=day')
    navigate('/dashboard?range=year', { replace: true })
    unsubscribe()
    expect(notified).toBe(2)
  })
})
