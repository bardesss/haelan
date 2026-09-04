// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { ErrorBoundary } from '../src/components/ErrorBoundary.js'
import { Card } from '../src/components/Card.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // React logs a caught error itself, and so does the boundary. Neither is a failure, and a test
  // that let them through would bury a real warning in noise.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

function Boom({ throws }: { throws: boolean }) {
  if (throws) throw new Error('field was undefined')
  return <p>recovered</p>
}

const mount = (node: React.ReactNode) => {
  act(() => { root?.render(<I18nProvider lng="en">{node}</I18nProvider>) })
}

describe('ErrorBoundary', () => {
  // The whole point. Without this the reader gets a white screen for one absent field, which is
  // what happened when a server older than the frontend answered without a `naps` field.
  it('renders the error state instead of unmounting when a child throws', () => {
    mount(<ErrorBoundary><Boom throws /></ErrorBoundary>)
    expect(container!.textContent).toContain('This did not load.')
  })

  it('renders its children untouched when nothing throws', () => {
    mount(<ErrorBoundary><Boom throws={false} /></ErrorBoundary>)
    expect(container!.textContent).toContain('recovered')
  })

  // A boundary that latches forever has traded a white screen for a permanently dead card. The
  // retry has to remount the subtree, which a boolean flag alone does not do: React reuses the
  // same instances, so the child must be given a new key to re-run cleanly.
  it('recovers when the retry is pressed and the child stops throwing', () => {
    mount(<ErrorBoundary><Boom throws /></ErrorBoundary>)
    expect(container!.textContent).toContain('This did not load.')

    mount(<ErrorBoundary><Boom throws={false} /></ErrorBoundary>)
    const retry = container!.querySelector('button')!
    act(() => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(container!.textContent).toContain('recovered')
    expect(container!.textContent).not.toContain('This did not load.')
  })

  // It catches for the reader, not to hide a bug from whoever has to fix it.
  it('logs the error rather than swallowing it', () => {
    mount(<ErrorBoundary><Boom throws /></ErrorBoundary>)
    expect(console.error).toHaveBeenCalled()
  })

  // The property the granularity choice exists for, and the one a boundary placed too high gets
  // wrong. A page is not the unit; a card is.
  it('leaves a sibling card standing when one card throws', () => {
    mount(
      <>
        <Card span={4} label="Broken"><Boom throws /></Card>
        <Card span={4} label="Fine"><p>still here</p></Card>
      </>,
    )
    expect(container!.textContent).toContain('still here')
  })

  // The failed card keeps its own frame and its label, so the reader can see WHICH card failed.
  // A boundary wrapped around Card from outside would take the label with it.
  it('keeps the failed card its label', () => {
    mount(<Card span={4} label="Broken"><Boom throws /></Card>)
    expect(container!.textContent).toContain('Broken')
    expect(container!.textContent).toContain('This did not load.')
  })
})
