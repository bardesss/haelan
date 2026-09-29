// @vitest-environment happy-dom
// happy-dom: the arrows are clicked and their keys pressed for real.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { StepArrows } from '../src/components/StepArrows.js'
import { DetailNav } from '../src/components/PageHeader.js'
import { DayNav } from '../src/pages/dashboard/DayNav.js'
import { glanceBody } from './glanceFixture.js'

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

  // A detail page's navigator hands its own escape hatch through to the arrows it draws: the
  // workout page's map and panels have arrow keys of their own.
  it('DetailNav passes ignoreKeysInside through to its arrows', () => {
    const onPick = vi.fn()
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <div data-map=""><button type="button" data-testid="map">Map</button></div>
          <DetailNav label="Nights" previous="2026-09-21" next="2026-09-23" onPick={onPick}
            labels={{ previous: 'Previous night', next: 'Next night' }} back={{ to: '/sleep', text: 'All nights' }}
            ignoreKeysInside="[data-map]" />
        </I18nProvider>,
      )
    })
    press('ArrowLeft', container!.querySelector('[data-testid="map"]')!)
    expect(onPick).not.toHaveBeenCalled()
    press('ArrowLeft')
    expect(onPick.mock.calls).toEqual([['2026-09-21']])
  })

  // The dashboard's arrows and a detail page's must look alike: same element, same classes, same
  // wrapper, so no rule can reach one pair and not the other. Checked with the same state on both
  // (both neighbours present), since a disabled arrow is meant to look different.
  it('draws the dashboard\'s arrows and a detail page\'s identically', () => {
    const arrows = (): string[] => [...container!.querySelectorAll<HTMLButtonElement>('button[aria-keyshortcuts^="Arrow"]')]
      .map((b) => `${b.parentElement!.className} > ${b.tagName}.${b.className} ${b.innerHTML}`)
    act(() => {
      root!.render(<I18nProvider lng="en"><DayNav glance={{ ...glanceBody(), today: '2026-09-22', finished: true, nav: { previous: '2026-09-21', next: '2026-09-23' } }} onPick={() => {}} /></I18nProvider>)
    })
    const dashboard = arrows()
    act(() => {
      root!.render(
        <I18nProvider lng="en">
          <DetailNav label="Nights" previous="2026-09-21" next="2026-09-23" onPick={() => {}}
            labels={{ previous: 'Previous night', next: 'Next night' }} back={{ to: '/sleep', text: 'All nights' }} />
        </I18nProvider>,
      )
    })
    expect(dashboard).toHaveLength(2)
    expect(arrows()).toEqual(dashboard)
  })

  it('sets titles and aria-keyshortcuts', () => {
    mount('2026-09-21', '2026-09-23', () => {})
    expect(button('Previous day')!.title).toBe('Previous day (←)')
    expect(button('Next day')!.title).toBe('Next day (→)')
    expect(button('Previous day')!.getAttribute('aria-keyshortcuts')).toBe('ArrowLeft')
    expect(button('Next day')!.getAttribute('aria-keyshortcuts')).toBe('ArrowRight')
  })
})
