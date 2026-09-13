// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { Link, navigate, setBaseForTest, useRoute, withBase } from '../src/router.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  // The base is module state; a test that set it must not leak into the next file.
  setBaseForTest('')
})

function Path() {
  return <span data-testid="path">{useRoute()}</span>
}

describe('with no base, which is what a real instance ships', () => {
  it('reports the browser path unchanged', () => {
    window.history.replaceState(null, '', '/activity?range=week')
    act(() => { root?.render(<Path />) })
    expect(container?.textContent).toBe('/activity?range=week')
  })

  it('navigates to exactly the path it was given', () => {
    navigate('/sleep')
    expect(window.location.pathname).toBe('/sleep')
  })

  it('renders a link href unchanged', () => {
    act(() => { root?.render(<Link to="/recovery">go</Link>) })
    expect(container?.querySelector('a')?.getAttribute('href')).toBe('/recovery')
  })

  it('leaves withBase a no-op', () => {
    expect(withBase('/health')).toBe('/health')
  })
})

describe('under a base, which is how the demo is served', () => {
  beforeEach(() => { setBaseForTest('/demo/') })

  it('reports the app-relative path, not the browser one', () => {
    window.history.replaceState(null, '', '/demo/activity?range=week')
    act(() => { root?.render(<Path />) })
    expect(container?.textContent).toBe('/activity?range=week')
  })

  it('treats the base itself as the root route', () => {
    window.history.replaceState(null, '', '/demo')
    act(() => { root?.render(<Path />) })
    expect(container?.textContent).toBe('/')
  })

  it('treats the base with a trailing slash as the root route', () => {
    window.history.replaceState(null, '', '/demo/')
    act(() => { root?.render(<Path />) })
    expect(container?.textContent).toBe('/')
  })

  it('prefixes the base when navigating', () => {
    navigate('/sleep')
    expect(window.location.pathname).toBe('/demo/sleep')
  })

  it('prefixes the base in a link href', () => {
    act(() => { root?.render(<Link to="/recovery">go</Link>) })
    expect(container?.querySelector('a')?.getAttribute('href')).toBe('/demo/recovery')
  })

  it('does not strip a path that merely starts with the same letters', () => {
    // '/demonstration' is not inside '/demo'. Stripping by string prefix without checking the
    // segment boundary would report '/nstration' and route to nothing.
    window.history.replaceState(null, '', '/demonstration')
    act(() => { root?.render(<Path />) })
    expect(container?.textContent).toBe('/demonstration')
  })
})
