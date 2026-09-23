// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { Shortcuts } from '../src/components/Shortcuts.js'
import { isForeignKey } from '../src/ui/shortcuts.js'

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
})

const NONE: ReadonlySet<string> = new Set()

function mount(excluded: ReadonlySet<string> = NONE, lng = 'en'): void {
  act(() => { root?.render(<I18nProvider lng={lng}><Shortcuts excludedDataTypes={excluded} /></I18nProvider>) })
}

// One act() per event, so a dialog opened by one key has committed before the next key arrives.
const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

const openDialog = () => document.querySelector<HTMLDialogElement>('dialog[open]')
const options = () => [...document.querySelectorAll('dialog[open] [role="option"]')].map((o) => o.textContent)

function type(input: HTMLInputElement, value: string): void {
  // The native setter, so React's value tracker sees a change (control-row.test.tsx explains why).
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('isForeignKey', () => {
  const key = (init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true, ...init })
    Object.defineProperty(event, 'target', { value: target })
    return event
  }

  it('claims nothing for a plain key on the page', () => {
    expect(isForeignKey(key())).toBe(false)
  })

  it('leaves Shift alone, since "?" needs it', () => {
    expect(isForeignKey(key({ shiftKey: true }))).toBe(false)
  })

  it('claims a key typed into a field, a select or anything editable', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isForeignKey(key({}, document.createElement(tag))), tag).toBe(true)
    }
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // happy-dom does not derive isContentEditable from the attribute, so it is set the way a
    // browser would report it.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isForeignKey(key({}, editable))).toBe(true)
  })

  it('claims any key held with Ctrl, Cmd or Alt', () => {
    expect(isForeignKey(key({ ctrlKey: true }))).toBe(true)
    expect(isForeignKey(key({ metaKey: true }))).toBe(true)
    expect(isForeignKey(key({ altKey: true }))).toBe(true)
  })
})

describe('the go-to box', () => {
  it('opens on "/" with the search field focused and every rail page listed', () => {
    mount()
    press('/')
    const dialog = openDialog()
    expect(dialog?.getAttribute('aria-label')).toBe('Go to a page')
    expect(document.activeElement?.className).toContain('goto-input')
    expect(options()).toEqual([
      'Dashboard', 'Records', 'Activity', 'Sleep', 'Recovery', 'Health', 'Weight', 'Nutrition', 'Notes', 'Settings', 'Account',
    ])
  })

  it('filters by name and goes to the chosen page on Enter', () => {
    mount()
    press('/')
    const input = document.activeElement as HTMLInputElement
    type(input, 'sle')
    expect(options()).toEqual(['Sleep'])
    press('Enter', input)
    expect(window.location.pathname).toBe('/sleep')
    expect(openDialog()).toBeNull()
  })

  it('moves the choice with the arrow keys', () => {
    mount()
    press('/')
    const input = document.activeElement as HTMLInputElement
    type(input, 're')
    expect(options()).toEqual(['Records', 'Recovery'])
    press('ArrowDown', input)
    press('Enter', input)
    expect(window.location.pathname).toBe('/recovery')
  })

  it('matches the page names in the reader\'s own language', () => {
    mount(NONE, 'nl')
    press('/')
    const input = document.activeElement as HTMLInputElement
    type(input, 'slaap')
    expect(options()).toEqual(['Slaap'])
  })

  it('says so when nothing matches, and Enter then goes nowhere', () => {
    mount()
    press('/')
    const input = document.activeElement as HTMLInputElement
    type(input, 'zzz')
    expect(document.querySelector('dialog[open] .goto-empty')?.textContent).toBe('No page by that name.')
    press('Enter', input)
    expect(window.location.pathname).toBe('/')
  })

  it('offers no page the rail has hidden', () => {
    mount(new Set(['nutrition-log', 'hydration-log', 'food']))
    press('/')
    expect(options()).not.toContain('Nutrition')
  })

  it('starts empty each time it opens', () => {
    mount()
    press('/')
    type(document.activeElement as HTMLInputElement, 'sle')
    act(() => { openDialog()!.close() })
    expect(openDialog()).toBeNull()
    press('/')
    expect((document.activeElement as HTMLInputElement).value).toBe('')
    expect(options()).toHaveLength(11)
  })
})

describe('the shortcut list', () => {
  it('opens on "?" and names every key', () => {
    mount()
    press('?', document.body, { shiftKey: true })
    expect(openDialog()?.getAttribute('aria-label')).toBe('Keyboard shortcuts')
    const rows = [...document.querySelectorAll('dialog[open] .shortcut-row')].map((row) =>
      [[...row.querySelectorAll('kbd')].map((k) => k.textContent).join(' '), row.querySelector('dd')!.textContent])
    expect(rows).toEqual([
      ['← →', 'Previous or next period'],
      ['T', 'Back to today'],
      ['1 2 3 4 5', 'Day, week, month, 3 months, year'],
      ['/', 'Go to a page by name'],
      ['?', 'This list'],
      ['Esc', 'Close a dialog'],
    ])
  })

  it('does not open a second dialog over the first', () => {
    mount()
    press('/')
    press('?', document.body, { shiftKey: true })
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
    expect(openDialog()?.getAttribute('aria-label')).toBe('Go to a page')
  })
})
