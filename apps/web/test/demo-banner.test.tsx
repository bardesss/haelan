// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { ApiError } from '../src/api/apiError.js'
import { DemoBanner, mountDemoBanner } from '../src/demo/DemoBanner.js'
import { createDemoTransport } from '../src/demo/client.js'

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
  document.querySelectorAll('[data-demo-banner]').forEach((host) => host.remove())
})

describe('the banner', () => {
  it('states all three things a visitor needs to know', () => {
    act(() => { root?.render(<DemoBanner />) })
    const text = container?.textContent ?? ''
    expect(text).toMatch(/generated/i)          // not anyone's real health history
    expect(text).toMatch(/reload/i)             // writes live in this tab only
    expect(text).toMatch(/derived|cascade/i)    // the fidelity limit, said out loud
  })

  // Task 18: at phone width the banner shows only its first two sentences and a disclosure for
  // the rest, so the DOM has to carry both pieces separately rather than one paragraph. NOT a
  // native <details>/<summary>: a closed <details> hides its own children in a way author CSS on
  // the child cannot override (Chromium: a closed details' child fails checkVisibility() even
  // under a rule that sets `display: inline` on it directly), which silently hid the rest of the
  // notice from every desktop visitor once this banner first grew a disclosure - happy-dom does
  // not model that hidden layer, which is why this file stayed green through it. The toggle is
  // therefore a plain button with real React state behind it, and the rest a plain paragraph
  // collapsed by a CSS class app.css only applies below the phone breakpoint.
  it('splits into a lead and a toggled rest, with no <details> for the hidden-child trap to hide behind', () => {
    act(() => { root?.render(<DemoBanner />) })
    expect(container?.querySelector('details')).toBeNull()
    const lead = container?.querySelector('.demo-banner-lead')
    const rest = container?.querySelector('.demo-banner-rest')
    const toggle = container?.querySelector('.demo-banner-toggle')
    expect(lead?.textContent).toMatch(/This is a demo\..*ends on/)
    // The fidelity-limit sentence and the reload sentence are both in the toggled rest, not the
    // lead: a phone reader who never presses "More" still gets the two sentences the brief names.
    expect(lead?.textContent).not.toMatch(/reload|derived/i)
    expect(rest?.textContent).toMatch(/reload/i)
    expect(rest?.textContent).toMatch(/derived/i)

    // Closed by default, and the button's own accessible state says so - `aria-controls` points at
    // the rest by id rather than by a container the rest happens to sit in, and both flip together
    // on a click.
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.textContent).toBe('More')
    const restId = rest?.getAttribute('id')
    expect(restId).toBeTruthy()
    expect(toggle?.getAttribute('aria-controls')).toBe(restId)
    expect(rest?.className).toContain('is-collapsed')

    act(() => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle?.textContent).toBe('Less')
    expect(rest?.className).not.toContain('is-collapsed')
  })

  it('mounts exactly one host even if the entry runs twice', () => {
    mountDemoBanner()
    mountDemoBanner()
    expect(document.querySelectorAll('[data-demo-banner]')).toHaveLength(1)
  })

  // happy-dom has no layout engine - every element's real getBoundingClientRect is the zero rect,
  // and its ResizeObserver never delivers a notification for an actual size change (there is never
  // one to detect) - so neither "the banner ends up some real number of pixels tall" nor "a resize
  // is what corrects a wrong value" can be asserted honestly here. What the fix in this task
  // actually changed is *when* the first measurement happens: DemoBanner.tsx used to measure `host`
  // synchronously right after `createRoot(host).render(...)` returned, which reads `host` before
  // its content has actually committed: createRoot schedules the initial render rather than
  // performing it, so the host is still empty when render() returns, and both a real browser and
  // this environment measured it as zero. Now DemoBanner measures
  // itself from its own useLayoutEffect, which by definition cannot run before that commit. This
  // fakes just enough of getBoundingClientRect - zero for an empty host, a real number once content
  // has actually landed in it - to make that ordering observable without needing real layout, and
  // is what would have caught the regression this task fixed. scripts/layout-check.mjs's rail-foot
  // check is what covers the genuine reflow-and-ResizeObserver path this can't.
  it('measures the host only after the banner has actually committed into it, not before', () => {
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute('data-demo-banner') && this.childNodes.length > 0) {
        return { height: 42 } as DOMRect
      }
      return original.call(this)
    }
    try {
      act(() => { mountDemoBanner() })
      expect(document.documentElement.style.getPropertyValue('--chrome-above')).toBe('42px')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
      document.documentElement.style.removeProperty('--chrome-above')
    }
  })

  // Closing the notice has to give its height back too: --chrome-above left at the banner's height
  // would keep the rail pushed down under a banner that is no longer drawn.
  it('closes on its button, gives its height back, and stays closed for the rest of the tab', () => {
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute('data-demo-banner')) return { height: this.childNodes.length > 0 ? 42 : 0 } as DOMRect
      return original.call(this)
    }
    try {
      act(() => { mountDemoBanner() })
      const host = document.querySelector('[data-demo-banner]')!
      expect(document.documentElement.style.getPropertyValue('--chrome-above')).toBe('42px')
      const close = host.querySelector('.demo-banner-close')!
      expect(close.getAttribute('aria-label')).toBe('Dismiss the demo notice')
      act(() => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(host.textContent).toBe('')
      expect(document.documentElement.style.getPropertyValue('--chrome-above')).toBe('0px')
      // A fresh render in the same tab reads the choice back rather than showing it again.
      act(() => { root?.render(<DemoBanner />) })
      expect(container?.textContent).toBe('')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
      document.documentElement.style.removeProperty('--chrome-above')
      window.sessionStorage.clear()
    }
  })
})

describe('the banner in the visitor\'s own language', () => {
  // navigator.language is read-only by default; a data descriptor lets each test set it. happy-dom
  // defines `language` as a getter on Navigator.prototype rather than as an own property of
  // window.navigator, so Object.getOwnPropertyDescriptor(window.navigator, 'language') reads
  // undefined - there was never an own-property descriptor here for an `if (originalLanguage)`
  // restore to run, which is why that guard never fired and left the stubbed value behind for
  // every test file sharing this worker. setLanguage below shadows the prototype getter with an
  // own data property, so deleting that own property in the teardown is what uncovers the
  // prototype getter again, rather than restoring a descriptor that was never actually captured.
  function setLanguage(tag: string): void {
    Object.defineProperty(window.navigator, 'language', { value: tag, configurable: true })
  }

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['language']
  })

  it('renders Dutch for a Dutch browser, including the fidelity-limit sentence', () => {
    setLanguage('nl-NL')
    act(() => { root?.render(<DemoBanner />) })
    const text = container?.textContent ?? ''
    expect(text).toMatch(/gegenereerd/i)   // not anyone's real health history
    expect(text).toMatch(/herladen/i)      // writes live in this tab only
    expect(text).toMatch(/afgeleid/i)      // the fidelity limit, in Dutch
    expect(text).not.toMatch(/generated/i) // the English string must not also be present
    expect(container?.querySelector('.demo-banner-toggle')?.textContent).toBe('Meer')
  })

  it('falls back to English for any browser language that is not Dutch', () => {
    setLanguage('fr-FR')
    act(() => { root?.render(<DemoBanner />) })
    const text = container?.textContent ?? ''
    expect(text).toMatch(/generated/i)
  })
})

describe('the actions a static demo cannot honour', () => {
  const transport = () => createDemoTransport(async () => ({ '/api/auth/me': 'me.json' }))

  it('refuses a sync run with an error the UI already renders', async () => {
    const error = await transport().apiSend('POST', '/api/sync/run')
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('config')
    expect((error as ApiError).message).toMatch(/demo/i)
  })

  it('refuses sign-out and the maintenance actions the same way', async () => {
    for (const path of ['/api/auth/logout', '/api/settings/maintenance/backup', '/api/settings/maintenance/reclaim']) {
      const error = await transport().apiSend('POST', path).then(() => null, (thrown: unknown) => thrown)
      expect(error, path).toBeInstanceOf(ApiError)
    }
  })

  it('does not swallow the writes that do work', async () => {
    // The refusal must not become a blanket "no non-GET": Task 6's overlay writes go through it.
    const written = await transport().apiSend('PUT', '/api/v1/p/demo/notes/2026-09-02', { body: 'fine' })
    expect(written).toHaveProperty('id')
  })
})
