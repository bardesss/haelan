// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { usePageControls } from '../src/controls/usePageControls.js'
import type { PageControlsState } from '../src/controls/usePageControls.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Each test drives its own history. Without this a test inherits whatever the previous one
  // navigated to, which is the kind of order dependence that only shows up when a file is run
  // on its own months later.
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

/** Mounts a tree and flushes effects. Every render in these tests goes through act. */
function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

/** A client that does not retry, so a failed query surfaces in the test rather than after it. */
function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

let seen: PageControlsState | null = null

function Probe() {
  seen = usePageControls()
  return null
}

// The session supplies the person's timezone. A stub client is enough: these tests are about the
// URL round trip, not about fetching.
function mountProbe(): void {
  mount(withQuery(<Probe />))
}

describe('usePageControls', () => {
  it('reads the range and anchor out of the URL and resolves them to a period', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    expect(seen!.tab).toBe('month')
    expect(seen!.from).toBe('2026-08-01')
    expect(seen!.to).toBe('2026-08-31')
  })

  // The whole point of putting state in the URL: a change goes to the URL, and the hook reads it
  // back. If this passes while the hook keeps its own copy, the copy is what is being tested.
  it('writes a tab change to the URL and reads the new period back', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    act(() => { seen!.setTab('week') })
    expect(window.location.search).toContain('range=week')
    expect(seen!.from).toBe('2026-08-10')
    expect(seen!.to).toBe('2026-08-16')
  })

  it('steps the anchor by one whole period', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    act(() => { seen!.step(1) })
    expect(seen!.anchor).toBe('2026-09-15')
    expect(seen!.from).toBe('2026-09-01')
  })

  // A tab change is somewhere to go back from. Thirty stepper clicks are not.
  it('pushes a tab change and replaces a step', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15')
    mountProbe()
    const afterMount = window.history.length
    act(() => { seen!.setTab('day') })
    expect(window.history.length).toBe(afterMount + 1)
    const afterTab = window.history.length
    act(() => { seen!.step(1) })
    act(() => { seen!.step(1) })
    expect(window.history.length).toBe(afterTab)
  })

  it('keeps the other parameters when one changes', () => {
    window.history.replaceState(null, '', '/dashboard?range=month&on=2026-08-15&source=watch')
    mountProbe()
    act(() => { seen!.setTab('year') })
    expect(window.location.search).toContain('source=watch')
    expect(window.location.search).toContain('on=2026-08-15')
  })

  it('carries the source through and lets it change', () => {
    window.history.replaceState(null, '', '/dashboard?source=watch')
    mountProbe()
    expect(seen!.source).toBe('watch')
    act(() => { seen!.setSource('merged') })
    expect(seen!.source).toBe('merged')
  })
})
