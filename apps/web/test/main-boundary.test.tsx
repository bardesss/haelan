// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'

// The real App is the whole app: SetupApp, SignIn, Shell and every page behind them, each with
// its own data hooks. What this file asserts is what main.tsx wraps around it, so App is replaced
// by the one thing that matters here, a component that throws the way a version skewed field
// does.
vi.mock('../src/Shell.js', () => ({
  App: () => { throw new Error('naps was undefined') },
}))

beforeEach(() => {
  // main.tsx renders into #root and asserts it exists, exactly as index.html provides it.
  document.body.innerHTML = '<div id="root"></div>'
  // React reports the caught error itself, and so does the boundary. Neither is a failure here.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('main.tsx', () => {
  // Shell's two boundaries sit below the sign-in and setup gates, so before this the surfaces a
  // fresh upgrade meets first (the wizard, the sign-in screen, Shell's own error and pending
  // branches) had no boundary at all: one absent field emptied the root and the reader got a
  // white screen, the exact failure the boundary was introduced to end.
  //
  // Imported for its side effect rather than called, because main.tsx is the entry script and
  // rendering at module scope is the thing being asserted. Inside act, so React finishes the
  // commit before the assertions read the DOM.
  it('renders the error state rather than an empty root when the app throws', async () => {
    await act(async () => { await import('../src/main.js') })

    const root = document.getElementById('root')!
    expect(root.textContent).toContain('This did not load.')
    // Named separately: a boundary that caught the throw but rendered nothing would leave the
    // same white screen this exists to prevent, and the assertion above alone would not say so.
    expect(root.textContent).not.toBe('')
  })
})
