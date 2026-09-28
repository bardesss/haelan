// @vitest-environment happy-dom
// happy-dom: the arrows are clicked and their keys pressed for real.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { StepArrows } from '../src/components/StepArrows.js'

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

function mount(previous: string | null, next: string | null, onPick: (target: string) => void, extra: ReactNode = null, ignoreKeysInside?: string): void {
  act(() => {
    root!.render(
      <I18nProvider lng="en">
        {extra}
        <StepArrows previous={previous} next={next} onPick={onPick}
          labels={{ previous: 'Previous day', next: 'Next day' }} ignoreKeysInside={ignoreKeysInside} />
      </I18nProvider>,
    )
  })
}

const button = (name: string): HTMLButtonElement | undefined =>
  [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === name)

function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

describe('StepArrows', () => {
  it('clicking an arrow picks its neighbour', () => {
    const onPick = vi.fn()
    mount('2026-09-21', '2026-09-23', onPick)
    act(() => { button('Previous day')!.click() })
    act(() => { button('Next day')!.click() })
    expect(onPick.mock.calls).toEqual([['2026-09-21'], ['2026-09-23']])
  })

  it('← and → step to the neighbour', () => {
    const onPick = vi.fn()
    mount('2026-09-21', '2026-09-23', onPick)
    press('ArrowLeft')
    press('ArrowRight')
    expect(onPick.mock.calls).toEqual([['2026-09-21'], ['2026-09-23']])
  })

  it('a null neighbour disables its button and ignores its key', () => {
    const onPick = vi.fn()
    mount(null, null, onPick)
    expect(button('Previous day')!.disabled).toBe(true)
    expect(button('Next day')!.disabled).toBe(true)
    press('ArrowLeft')
    press('ArrowRight')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a key inside the ignored selector does nothing', () => {
    const onPick = vi.fn()
    mount('2026-09-21', '2026-09-23', onPick, (
      <div data-log-panel=""><button type="button" data-testid="chip">Caffeine</button></div>
    ), '[data-calendar], [data-log-panel]')
    const chip = container!.querySelector('[data-testid="chip"]')!
    press('ArrowLeft', chip)
    press('ArrowRight', chip)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('sets titles and aria-keyshortcuts', () => {
    mount('2026-09-21', '2026-09-23', () => {})
    expect(button('Previous day')!.title).toBe('Previous day (←)')
    expect(button('Next day')!.title).toBe('Next day (→)')
    expect(button('Previous day')!.getAttribute('aria-keyshortcuts')).toBe('ArrowLeft')
    expect(button('Next day')!.getAttribute('aria-keyshortcuts')).toBe('ArrowRight')
  })
})
