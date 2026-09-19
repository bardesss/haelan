// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { CardGrid } from '../src/components/CardGrid.js'
import { Card } from '../src/components/Card.js'

// No I18nProvider, the same trick metric-card.test.tsx uses: with no i18next instance
// initialised, t() returns the key it was asked for, so 'emptyState.page.title' below is an
// assertion about the key this component chose, not about copy a locale file can change.
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
  act(() => { root?.render(node) })
}

describe('CardGrid', () => {
  it('says nothing of its own while cards are present', () => {
    mount(<CardGrid><Card span={6}><span>one</span></Card><Card span={6}><span>two</span></Card></CardGrid>)
    expect(container!.textContent).toContain('one')
    expect(container!.textContent).not.toContain('emptyState.page.title')
  })

  it('still says nothing when only some cards hid themselves', () => {
    mount(<CardGrid>{null}<Card span={6}><span>two</span></Card></CardGrid>)
    expect(container!.textContent).toContain('two')
    expect(container!.textContent).not.toContain('emptyState.page.title')
  })

  it('renders the page level empty state once every card has hidden itself', () => {
    mount(<CardGrid>{null}{null}</CardGrid>)
    expect(container!.textContent).toContain('emptyState.page.title')
    expect(container!.textContent).toContain('emptyState.page.detail')
  })

  // The bug a naive version ships: on the first commit nothing has registered yet, so the
  // fallback renders on every page load and is then taken away. act() flushes effects, so this
  // asserting the DOM after a single render is asserting what a reader would see settle.
  it('does not flash the empty state on a grid whose cards are present', () => {
    mount(<CardGrid><Card span={12}><span>one</span></Card></CardGrid>)
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
    expect(container!.textContent).not.toContain('emptyState.page')
  })

  // The oscillation the spec names: a fallback that registered itself would take the count to
  // one, stop rendering, drop the count to zero, and render again forever. One .card, not two,
  // and a stable render is the proof it sits outside the provider.
  it('does not count its own fallback card', () => {
    mount(<CardGrid>{null}</CardGrid>)
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
    expect(container!.textContent).toContain('emptyState.page.title')
  })

  // The carve-out that would otherwise cancel the feature on the one page that prompted it.
  // Dashboard's flagged days card reads the reader's own annotations, so it renders on a day
  // where nothing was synced at all; counting like any other card, it alone would hold the tally
  // above zero forever.
  it('lets an ambient card render without speaking for the page', () => {
    mount(<CardGrid><Card span={4} ambient><span>flagged</span></Card></CardGrid>)
    expect(container!.textContent).toContain('flagged')
    expect(container!.textContent).toContain('emptyState.page.title')
  })

  it('counts a card that did not ask to be ambient', () => {
    mount(<CardGrid><Card span={4}><span>flagged</span></Card></CardGrid>)
    expect(container!.textContent).not.toContain('emptyState.page.title')
  })

  // A Card outside any CardGrid must keep working: Settings, Account, the detail pages and
  // ConnectGoogle all render one with no grid above it.
  it('lets a card render with no grid above it', () => {
    mount(<Card span={12}><span>alone</span></Card>)
    expect(container!.textContent).toContain('alone')
  })
})
