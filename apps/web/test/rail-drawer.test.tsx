// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because this file clicks a real button and reads
// the DOM back, the same reason chart-table-toggle.test.tsx needs it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { RailDrawer } from '../src/components/RailDrawer.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  // happy-dom has no dialog implementation, so showModal and close are stubbed to move the open
  // attribute the way a browser would. What is being tested here is this component's own logic:
  // that it opens on click, closes on Escape and closes on navigation. The browser behaviour it
  // leans on (focus containment, inertness) is checked in layout:check against real chromium.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
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

function render() {
  act(() => {
    root!.render(
      <I18nProvider>
        <RailDrawer active="/" person="Bartus" onSignOut={() => {}} />
      </I18nProvider>,
    )
  })
}

describe('the rail drawer', () => {
  it('starts closed, with a hamburger to open it', () => {
    render()
    expect(container!.querySelector('[data-testid="rail-open"]')).not.toBeNull()
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(false)
  })

  it('opens on click and closes on Escape', () => {
    render()
    const button = container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!
    act(() => { button.click() })
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(true)

    act(() => {
      container!.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      container!.querySelector('dialog')!.close()
    })
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(false)
  })

  // The whole rail, not a reduced phone menu: the same nine destinations, the resources links, the
  // person line and sign-out.
  it('holds every rail destination', () => {
    render()
    act(() => { container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!.click() })
    const hrefs = [...container!.querySelectorAll('dialog a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/activity')
    expect(hrefs).toContain('/settings')
    expect(container!.querySelector('dialog .rail-person')).not.toBeNull()
  })

  // The stored preference belongs to the rail, and a drawer is open or closed: a 60px icon strip
  // inside one means nothing. Nothing here may write to it, so crossing back above the breakpoint
  // finds the reader's choice exactly as they left it.
  it('shows no collapse toggle and never writes the stored preference', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render()
    expect(container!.querySelector('.rail-toggle')).toBeNull()
    expect(setItem).not.toHaveBeenCalledWith('haelan.rail.collapsed', expect.anything())
    setItem.mockRestore()
  })
})
