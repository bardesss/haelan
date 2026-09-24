// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because every case here presses something and
// reads the DOM back. The rest of the rail's tests render to static markup, which can see that
// the trigger exists but never that it opens, and the menu's whole reason for existing is what
// happens after a press.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { Sidebar } from '../src/components/Sidebar.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root!.unmount())
  container!.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

function render(onSignOut: () => void = () => {}, active = '/sleep', collapsible = true): void {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        <Sidebar person="Robin" active={active} onSignOut={onSignOut} collapsible={collapsible} />
      </I18nProvider>,
    )
  })
}

const trigger = (): HTMLButtonElement => container!.querySelector<HTMLButtonElement>('.rail-person')!
// Looked up on the whole document, not under the container: on the desktop rail the menu is
// portalled to document.body (see the case below that pins it), so a query scoped to where the
// rail was mounted would find nothing and every case here would pass or fail for the wrong reason.
const menu = (): HTMLElement | null => document.querySelector('.rail-menu')
const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.rail-menu-item')]

// A press on a control inside the menu has to arrive as the pair a real pointer sends, not as a
// bare click: the outside-press handler listens on pointerdown, and the bug it was written around
// is a pointerdown that tears the menu down before the click behind it can land. A helper that
// only dispatched `click` would pass against exactly the implementation that fails in a browser.
//
// One act() per event, not one around all three. A single act() batches the whole sequence and
// flushes once at the end, so the menu is still mounted when `click` is dispatched no matter what
// pointerdown did - which makes the bug invisible. Separate acts commit the pointerdown's state
// change before the click is sent, which is the order a browser uses, and is the difference
// between this file catching the defect below and merely describing it. Verified by moving the
// ref from the wrapper onto the trigger and watching the sign-out case go red.
function press(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  act(() => { el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) })
  act(() => { el.click() })
}

describe('the person menu in the rail foot', () => {
  it('is closed until the name is pressed', () => {
    render()
    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    press(trigger())
    expect(menu()).not.toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('holds the account page and sign out, and nothing else', () => {
    render()
    press(trigger())
    expect(items().map((el) => el.textContent?.trim())).toEqual(['Account', 'Sign out'])
    expect(items()[0]!.getAttribute('href')).toBe('/account')
  })

  // The defect a first version of this shipped with, and the reason the helper above sends a
  // pointerdown. Closing the menu on any press inside it unmounts the button between pointerdown
  // and click, so the click lands on nothing and sign out silently does nothing at all - which no
  // static render and no click-only test could have caught.
  it('signs out when sign out is pressed, rather than closing under the press', () => {
    const onSignOut = vi.fn()
    render(onSignOut)
    press(trigger())
    press(items()[1]!)
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    render()
    press(trigger())
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })
    expect(menu()).toBeNull()
  })

  // Inside the phone drawer this menu is a layer on top of a <dialog>, and Escape is that dialog's
  // own native way out - so an open menu has to claim the key or one press dismisses both. What
  // this can assert is that the press is claimed; that the drawer actually survives it is
  // layout:check's, because happy-dom has no native dialog and RailDrawer's own tests stub
  // showModal and close outright.
  it('claims the Escape press, so the dialog underneath it does not also close', () => {
    render()
    press(trigger())
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => { document.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
  })

  // The other half of it: with no menu open there is no listener, so Escape is the drawer's again.
  // A handler that swallowed the key unconditionally would leave a phone reader with no way out.
  it('leaves Escape alone when it is closed', () => {
    render()
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => { document.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  })

  it('closes on a press outside it, and the second press on the name closes it too', () => {
    render()
    press(trigger())
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(menu()).toBeNull()

    press(trigger())
    expect(menu()).not.toBeNull()
    press(trigger())
    expect(menu()).toBeNull()
  })

  // Link forwards no onClick, so the menu cannot close itself from the item that navigates. The
  // rail is not unmounted by a route change either, which would leave the menu hanging open over
  // the page it just opened. `active` changing is the signal.
  it('closes when the route changes under it', () => {
    render(() => {}, '/sleep')
    press(trigger())
    expect(menu()).not.toBeNull()
    render(() => {}, '/account')
    expect(menu()).toBeNull()
  })

  // Outside the rail, because the rail is a scroll container: overflow-y: auto computes
  // overflow-x to auto as well, and an absolutely positioned menu inside it is cut at the rail's
  // own edge. On a collapsed rail the menu opens to the right of the 60px strip, which is entirely
  // outside that box, so the menu was invisible there; layout:check's paintableAt probe is what
  // measured it in Chromium. What happy-dom can pin is the structural half: the menu is not a
  // descendant of the rail, so no ancestor's overflow can reach it.
  it('opens outside the rail on a desktop, where the rail cannot clip it', () => {
    render()
    press(trigger())
    expect(menu()).not.toBeNull()
    expect(menu()!.closest('.rail')).toBeNull()
  })

  // The cost of the portal, paid back. At the end of the body the menu is no longer next to the
  // name in tab order, so a keyboard reader who opened it would have to tab through the whole page
  // to reach Sign out; focus goes into it instead, and Escape hands it back to the name rather
  // than dropping it on the body.
  it('takes focus on a desktop and gives it back to the name on Escape', () => {
    render()
    press(trigger())
    expect(document.activeElement).toBe(items()[0])
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })
    expect(document.activeElement).toBe(trigger())
  })

  // The phone drawer is the other way round. It is a modal <dialog>, and everything outside a
  // modal dialog is inert, so a menu portalled to the body from in there would draw and then
  // refuse every press. It is also as wide as the screen, so there is nothing to clip it: the
  // menu stays where it was, inside the dialog, which is also where layout:check looks for it.
  it('stays inside the rail in the phone drawer, where the rest of the page is inert', () => {
    render(() => {}, '/sleep', false)
    press(trigger())
    expect(menu()).not.toBeNull()
    expect(menu()!.closest('.rail')).not.toBeNull()
  })

  it('marks the name as the current page only on the account page', () => {
    render(() => {}, '/sleep')
    expect(trigger().getAttribute('aria-current')).toBeNull()
    render(() => {}, '/account')
    expect(trigger().getAttribute('aria-current')).toBe('page')
  })
})
