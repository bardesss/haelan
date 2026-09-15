// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because this file clicks a real button and reads
// the DOM back, the same reason chart-table-toggle.test.tsx needs it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { RailDrawer } from '../src/components/RailDrawer.js'
import { RAIL_PATHS } from '../src/components/Sidebar.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
// Captured so afterEach can put them back. These are prototype methods on a global that every
// other file in the suite shares: left patched, a stub written for this file's needs becomes the
// dialog implementation any later file sees, and whichever one runs next in the same worker
// inherits it without ever asking for it.
const realShowModal = HTMLDialogElement.prototype.showModal
const realClose = HTMLDialogElement.prototype.close

beforeEach(() => {
  // happy-dom has no dialog implementation, so showModal and close are stubbed to move the open
  // attribute the way a browser would. What is being tested here is this component's own logic:
  // that it opens on click, closes on Escape and closes on navigation. The browser behaviour it
  // leans on (focus containment, inertness, and the scroll lock the page behind it needs) is
  // checked in layout:check against real chromium.
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
  HTMLDialogElement.prototype.showModal = realShowModal
  HTMLDialogElement.prototype.close = realClose
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

  // A plain mount is not a close: the hamburger's own focus-return effect watches `open`, which
  // starts false, and a useEffect always runs once after the first render regardless of its
  // dependency array. Without a mount guard that false-on-mount looks identical to the
  // true-to-false transition after Escape, and every phone page load silently focuses the menu
  // button before the reader does anything - an unexpected focus ring, and a screen reader
  // announcing "menu button" unprompted on a page the reader never touched.
  it('does not steal focus on mount', () => {
    render()
    const button = container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!
    expect(document.activeElement).not.toBe(button)
  })

  it('opens on click and closes on Escape, returning focus to the hamburger', () => {
    render()
    const button = container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!
    act(() => { button.click() })
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(true)

    act(() => {
      container!.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      container!.querySelector('dialog')!.close()
    })
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(false)
    // The one case the mount guard must not break: a real close still has to send focus back to
    // the control that opened it.
    expect(document.activeElement).toBe(button)
  })

  // The defect this component shipped with: Escape and a route change were the only two ways out,
  // and a phone has neither a key for the first nor, for a reader who opened the menu and then
  // decided to stay on the page they were already on, the second. The close control is what a
  // finger can find; the backdrop handler below is the gesture it will try first.
  it('closes on the close control, returning focus to the hamburger', () => {
    render()
    const button = container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!
    act(() => { button.click() })
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(true)

    const close = container!.querySelector<HTMLButtonElement>('dialog [data-testid="rail-close"]')
    expect(close, 'the drawer should carry a close control').not.toBeNull()
    act(() => { close!.click() })
    expect(container!.querySelector('dialog')?.hasAttribute('open')).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  // A click whose target is the dialog element itself landed on the backdrop: everything the
  // drawer renders is a descendant, and .rail fills the dialog's box edge to edge. The two
  // assertions are one rule read both ways, because a handler that closes on any click at all
  // would pass the first on its own and make the menu unusable.
  it('closes on a backdrop tap and not on a tap inside the drawer', () => {
    render()
    const open = () => act(() => { container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!.click() })
    const dialog = () => container!.querySelector('dialog')!

    open()
    act(() => { dialog().querySelector('.rail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(dialog().hasAttribute('open'), 'a tap inside the drawer closed it').toBe(true)

    act(() => { dialog().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(dialog().hasAttribute('open'), 'a tap on the backdrop did not close the drawer').toBe(false)
  })

  // The whole rail, not a reduced phone menu: every destination the rail links to, the resources
  // links, the person line and sign-out.
  //
  // Every path from RAIL_PATHS rather than a sample of two, and by path rather than by counting
  // .rail-item: the resources links carry .rail-item too, so a count passes with three
  // destinations dropped, and two named hrefs pass with the other seven dropped.
  it('holds every rail destination', () => {
    render()
    act(() => { container!.querySelector<HTMLButtonElement>('[data-testid="rail-open"]')!.click() })
    const hrefs = [...container!.querySelectorAll('dialog a')].map((a) => a.getAttribute('href'))
    expect(RAIL_PATHS.length, 'the rail should still link somewhere').toBeGreaterThan(0)
    for (const path of RAIL_PATHS) expect(hrefs, `the drawer has no link to ${path}`).toContain(path)
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
