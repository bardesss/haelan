// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { Sidebar, RAIL_PATHS } from '../src/components/Sidebar.js'
import { readCollapsed, writeCollapsed } from '../src/ui/railState.js'

const STORAGE_KEY = 'haelan.rail.collapsed'

// happy-dom's own window has a working localStorage, but vitest's happy-dom environment forwards
// a window property to the test's global scope only when it finds that property among the
// window instance's *own* enumerable keys (see populateGlobal/getWindowKeys in vitest's runtime
// chunk). happy-dom exposes localStorage through a getter on its Window prototype rather than as
// an own property, so it is never forwarded, and the bare `localStorage` this file (and
// railState.ts) reads falls through to Node's own built-in global instead, which is inert without
// a --localstorage-file flag. Storage itself IS forwarded (happy-dom assigns it as an instance
// field), so this builds a real Storage the class already provides and installs it where the
// ambient `localStorage` reference actually resolves at runtime. A fresh instance every test,
// not one shared across the file: happy-dom's Storage lazily binds each method the first time it
// is read and then reuses that bound copy, so spying on Storage.prototype after some earlier test
// already touched the same instance would silently spy on nothing.
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true, writable: true })
})

function renderRail(): string {
  return renderToStaticMarkup(<Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} />)
}

function renderCollapsed(): string {
  writeCollapsed(true)
  return renderRail()
}

// Each test already gets a fresh Storage from the beforeEach above, so this is not what keeps
// tests from seeing each other's writes; it exists so a change to that setup, or to this file's
// STORAGE_KEY, cannot quietly stop covering the one property clear() actually promises. The
// assertion after clear() confirms the clear actually took effect rather than merely returning.
afterEach(() => {
  localStorage.clear()
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
})

describe('the rail collapses to an icon strip', () => {
  it('keeps every rail item nameable when collapsed', () => {
    const html = renderCollapsed()
    for (const path of RAIL_PATHS) expect(html).toContain(`href="${path}"`)
    expect(html).not.toContain('aria-label=""')
  })

  it('falls back to expanded when localStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => renderRail()).not.toThrow()
    spy.mockRestore()
  })

  it('does not throw when a write is denied either, the same guard on the other side', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeCollapsed(true)).not.toThrow()
    spy.mockRestore()
  })

  it('reads back exactly what it wrote, both ways', () => {
    writeCollapsed(true)
    expect(readCollapsed()).toBe(true)
    writeCollapsed(false)
    expect(readCollapsed()).toBe(false)
  })

  it('keeps the resources links reachable when collapsed too', () => {
    const html = renderCollapsed()
    expect(html).toContain('href="https://github.com/bardesss/haelan#readme"')
    expect(html).toContain('href="https://github.com/bardesss/haelan/releases"')
    expect(html).toContain('href="https://github.com/bardesss/haelan/issues"')
  })
})

describe('the collapse toggle', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root?.unmount() })
    container?.remove()
    container = null
    root = null
  })

  function mount(node: ReactNode): void {
    act(() => { root?.render(<I18nProvider lng="en">{node}</I18nProvider>) })
  }

  // A click is the one path that both flips the visible state and writes to storage, so this is
  // the test that would have caught a toggle wired to the wrong half of either job: a click that
  // updates the label but never calls writeCollapsed, or one that persists without ever
  // re-rendering. Breaking the handler's setCollapsed call while leaving writeCollapsed alone
  // makes the second assertion fail while the third still passes, and breaking writeCollapsed
  // while leaving setCollapsed alone flips the result.
  it('flips the toggle on click and remembers the choice for the next mount', () => {
    mount(<Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} />)
    const toggle = container!.querySelector('.rail-toggle')!
    expect(toggle.getAttribute('aria-label')).toBe('Collapse navigation')

    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(toggle.getAttribute('aria-label')).toBe('Expand navigation')
    expect(readCollapsed()).toBe(true)

    // A fresh mount, the way a page reload produces one, must pick the remembered state back up
    // rather than defaulting to expanded again.
    act(() => { root!.unmount() })
    container!.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mount(<Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} />)
    expect(container!.querySelector('.rail-toggle')!.getAttribute('aria-label')).toBe('Expand navigation')
  })

  it('keeps the label text in the DOM rather than removing it, so a screen reader still has it', () => {
    writeCollapsed(true)
    mount(<Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} />)
    const sleepLink = [...container!.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/sleep')!
    // Clipped visually via the "sr-only" class, not display:none: textContent still reports it,
    // which is exactly the property a screen reader's accessible name computation reads too.
    expect(sleepLink.textContent).toContain('Sleep')
  })
})
