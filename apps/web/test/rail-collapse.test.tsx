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
// a window property to the test's global scope only through getWindowKeys/populateGlobal in
// vitest's runtime chunk, and that function's second filter skips any key that already exists on
// the test's global unless the key is explicitly listed in vitest's own KEYS array (or the
// environment's additionalKeys). Node ships its own inert `localStorage` global (the
// "ExperimentalWarning: localStorage is not available" you will see in this file's test output),
// so `localStorage` already exists on `global` before happy-dom's setup runs, `localStorage` is
// in neither list, and the filter leaves Node's inert version in place instead of forwarding
// happy-dom's working one. The bare `localStorage` this file (and railState.ts) reads therefore
// resolves to that inert global rather than to happy-dom's window's own. `Storage` the
// constructor IS forwarded (it is in vitest's KEYS array), so this builds a real Storage with the
// same class happy-dom itself uses and installs it where the ambient `localStorage` reference
// actually resolves at runtime. A fresh instance every test, not one shared across the file:
// happy-dom's Storage lazily binds each method the first time it is read and then reuses that
// bound copy, so spying on Storage.prototype after some earlier test already touched the same
// instance would silently spy on nothing.
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

// Restoring spies here rather than at the end of each test that installs one: a spy restored
// inline is skipped whenever an assertion above it throws first, and a mocked Storage.prototype
// method left in place then leaks into every test that runs after it. restoreAllMocks runs
// whether or not the test that installed the spy passed.
//
// A fresh Storage after that, rather than clearing the one the test just used: happy-dom's
// Storage caches each method the first time it is read, on the instance rather than the
// prototype, so a test that spied on Storage.prototype leaves its own instance permanently bound
// to the mock even once restoreAllMocks puts the real method back on the prototype. Checking
// clear() against that same instance would still throw here. This file's own beforeEach is not
// what keeps tests from seeing each other's writes, so this is not covering that; it exists so a
// change to either setup, or to this file's STORAGE_KEY, cannot quietly stop covering the one
// property clear() actually promises, on an instance nothing else touched.
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true, writable: true })
  localStorage.setItem(STORAGE_KEY, 'true')
  localStorage.clear()
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
})

// English names, matching en.json's sidebar.items values: the two markup tests below wrap the
// render in a real I18nProvider so the assertions check the actual name a reader (or a screen
// reader) gets, not the raw catalogue key renderToStaticMarkup falls back to without a provider.
const EXPECTED_NAMES: Record<string, string> = {
  '/': 'Dashboard',
  '/activity': 'Activity',
  '/sleep': 'Sleep',
  '/recovery': 'Recovery',
  '/health': 'Health',
  '/weight': 'Weight',
  '/nutrition': 'Nutrition',
  '/notes': 'Notes',
  '/settings': 'Settings',
}

function renderRailNamed(): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en"><Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} /></I18nProvider>,
  )
}

function renderCollapsedNamed(): string {
  writeCollapsed(true)
  return renderRailNamed()
}

describe('the rail collapses to an icon strip', () => {
  // Collapsing that never touches a class name is invisible to every other test in this file: the
  // toggle's own aria-label still flips, the hrefs are all still there, and every name is still in
  // the DOM regardless of whether the rail actually shrank. rail-collapsed and sr-only are the two
  // class names app.css keys its collapsed layout off, so asserting them here is the one place a
  // class assertion is the substance of the test rather than a proxy standing in for it.
  it('marks the nav collapsed and clips a label, rather than leaving the markup untouched', () => {
    const expandedHtml = renderRail()
    const collapsedHtml = renderCollapsed()
    expect(expandedHtml).not.toContain('rail-collapsed')
    expect(collapsedHtml).toContain('class="rail rail-collapsed"')
    expect(expandedHtml).not.toContain('class="sr-only"')
    expect(collapsedHtml).toContain('class="sr-only"')
  })

  it('keeps every rail item nameable when collapsed', () => {
    const html = renderCollapsedNamed()
    for (const path of RAIL_PATHS) {
      const name = EXPECTED_NAMES[path]
      expect(name, `no expected name recorded for ${path}`).toBeDefined()
      // Each path's own anchor, not the document as a whole: a name present anywhere in the page
      // does not prove the item at this path carries it, only that the word appears somewhere.
      const anchor = html.match(new RegExp(`<a href="${path}"[^>]*>.*?</a>`))?.[0]
      expect(anchor, `no anchor found for ${path}`).toBeDefined()
      expect(anchor, path).toContain(name)
    }
    expect(html).not.toContain('aria-label=""')
  })

  // The test above proves the accessible name survives collapse, which was always the stated point
  // of the feature. A sighted reader gets neither that clipped span nor a visible label, so before
  // this the collapsed rail was nine unlabelled glyphs with nothing anywhere naming them. Asserted
  // per anchor and in both directions: a title somewhere in the page does not prove this item has
  // one, and a title surviving on the expanded rail would pop a tooltip over the label it repeats.
  // Expanded is rendered first because renderCollapsedNamed writes the flag to storage, which the
  // next render would then read back.
  it('names each icon on hover when collapsed, and leaves the expanded rail alone', () => {
    const expanded = renderRailNamed()
    const collapsed = renderCollapsedNamed()
    for (const path of RAIL_PATHS) {
      const name = EXPECTED_NAMES[path]
      expect(name, `no expected name recorded for ${path}`).toBeDefined()
      const openTag = (html: string) => html.match(new RegExp(`<a href="${path}"[^>]*>`))?.[0]
      expect(openTag(collapsed), path).toContain(`title="${name}"`)
      expect(openTag(expanded), path).not.toContain('title=')
    }
  })

  it('names the sign out button, the account and the resources links too, which lose their labels with the rest', () => {
    const expanded = renderRailNamed()
    const collapsed = renderCollapsedNamed()
    for (const name of ['Sign out', 'Documentation', 'Changelog', 'Issues', 'Bartus']) {
      expect(collapsed, name).toContain(`title="${name}"`)
    }
    expect(expanded).not.toContain('title=')
  })

  it('falls back to expanded when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => renderRail()).not.toThrow()
  })

  it('does not throw when a write is denied either, the same guard on the other side', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeCollapsed(true)).not.toThrow()
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
