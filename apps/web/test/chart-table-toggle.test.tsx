// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because this file clicks a real button and reads
// the DOM back (createRoot + act), the same reason band-toggle.test.tsx needs it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act, useRef } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { ChartFigure } from '../src/charts/ChartFigure.js'

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

const table = {
  columns: ['Date', 'Steps', 'Note'],
  rows: [['2026-08-10', '9,000', ''], ['2026-08-11', 'no reading', 'travelling']],
}

// ChartFigure takes a ref for its canvas host; nothing in this file draws a chart, so a component
// wrapper supplies a real one rather than casting null into the prop.
function Harness() {
  const host = useRef<HTMLDivElement | null>(null)
  return <ChartFigure label="steps, august 2026" host={host} style={{ width: '100%', height: 34 }} table={table} />
}

function mount(lng = 'en'): { container: HTMLDivElement; toggle: () => HTMLElement } {
  act(() => { root!.render(<I18nProvider lng={lng}><Harness /></I18nProvider>) })
  return {
    container: container!,
    toggle: () => {
      const el = container!.querySelector('button')
      if (!el) throw new Error('no table toggle button found')
      return el
    },
  }
}

describe('the accessible table toggle', () => {
  // The whole point of the control, and the reason it is not a <details>: collapsed <details>
  // content leaves the accessibility tree. A screen reader must be handed this table whether the
  // button has been pressed or not, exactly as it was before this control existed.
  it('leaves the table in the document before the control is touched', () => {
    const { container } = mount()
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.textContent).toContain('2026-08-11')
    expect(container.textContent).toContain('travelling')
  })

  it('starts collapsed, so a first visit looks exactly as it did', () => {
    const { container, toggle } = mount()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('table')!.className).toContain('sr-only')
  })

  it('takes the clipping class off the table and its wrapper when pressed', () => {
    const { container, toggle } = mount()
    act(() => { toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const shown = container.querySelector('table')!
    expect(shown.className).not.toContain('sr-only')
    expect(shown.parentElement!.className).toContain('chart-table')
  })

  // The control has to name the region it controls, or a screen reader user hears a button with no
  // object. aria-controls must point at an element that actually exists in the document.
  it('points aria-controls at the wrapper it shows', () => {
    const { container, toggle } = mount()
    const id = toggle().getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(container.querySelector(`#${id}`)).not.toBeNull()
  })

  // The same rule band-toggle.test.tsx pins for its own control: no-hardcoded-strings reads text
  // between tags, so an English label on a Dutch page would go unseen by the suite.
  it('names the control in the page language rather than in English', () => {
    const { toggle } = mount('nl')
    expect(toggle().textContent, 'the Dutch label is missing or left in English').toBe('Cijfers tonen')
  })

  it('does not change a single cell of what the table says', () => {
    const { container, toggle } = mount()
    const before = container.querySelector('table')!.textContent
    act(() => { toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('table')!.textContent).toBe(before)
  })
})
