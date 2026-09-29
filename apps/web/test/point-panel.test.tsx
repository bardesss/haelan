// @vitest-environment happy-dom
//
// happy-dom, since the panel closes on a document's Escape and pointerdown. One act() per event:
// a pointerdown and its click batched into one act() would hide a panel that closed on the
// pointerdown before its own button's click could land.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { PointPanel } from '../src/pages/period/PointPanel.js'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

type Props = ComponentProps<typeof PointPanel>
function mount(o: Partial<Props> = {}, lng = 'en') {
  const props: Props = {
    title: 'Sun, Aug 3',
    rows: [{ label: 'Time asleep', value: '7h 19m' }, { label: 'Bedtime', value: '23:10' }],
    open: { to: '/sleep/night/2026-08-03', text: 'View night' },
    onAnnotate: vi.fn(), onClose: vi.fn(), ...o,
  }
  act(() => { root.render(<I18nProvider lng={lng}><PointPanel {...props} /></I18nProvider>) })
  return props
}

const dialog = () => container.querySelector('[role="dialog"]')
const press = (target: EventTarget) => act(() => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
const click = (target: HTMLElement) => act(() => { target.click() })

describe('PointPanel', () => {
  it('is a dialog named by its title, listing its rows, the way to the point and the annotate button', () => {
    mount()
    expect(dialog()?.getAttribute('aria-label')).toBe('Sun, Aug 3')
    const rows = [...container.querySelectorAll('.point-panel-row')].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
    expect(rows).toEqual([['Time asleep', '7h 19m'], ['Bedtime', '23:10']])
    const link = container.querySelector('a.card-link')
    expect(link?.textContent).toBe('View night')
    expect(link?.getAttribute('href')).toBe('/sleep/night/2026-08-03')
    expect(container.querySelector('button')?.textContent).toBe('Exclude or add a note')
  })

  it('words the annotate button in Dutch', () => {
    mount({}, 'nl')
    expect(container.querySelector('button')?.textContent).toBe('Uitsluiten of een notitie toevoegen')
  })

  it('reads a week\'s single row with no link', () => {
    mount({ title: 'Week of Aug 4', rows: [{ label: 'Time asleep', value: '7h 02m' }], open: null })
    expect(container.querySelectorAll('.point-panel-row')).toHaveLength(1)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('button')).not.toBeNull()
  })

  it('draws no action row with neither a link nor annotate', () => {
    mount({ open: null, onAnnotate: null })
    expect(container.querySelector('.point-panel-actions')).toBeNull()
  })

  it('calls onAnnotate from its button, and a press on the button does not close it', () => {
    const props = mount()
    const button = container.querySelector('button')!
    press(button)
    click(button)
    expect(props.onAnnotate).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const props = mount()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves an Escape a layer above already claimed', () => {
    const props = mount()
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    claimed.preventDefault()
    act(() => { document.dispatchEvent(claimed) })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('ignores other keys', () => {
    const props = mount()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes on a press outside it', () => {
    const props = mount()
    press(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('stops listening once it is gone', () => {
    const props = mount()
    act(() => { root.render(<I18nProvider lng="en"><div /></I18nProvider>) })
    press(document.body)
    expect(props.onClose).not.toHaveBeenCalled()
  })
})
