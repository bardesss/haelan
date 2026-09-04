// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { ErrorBoundary } from '../src/components/ErrorBoundary.js'
import { Card } from '../src/components/Card.js'
import { Shell } from '../src/Shell.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'

// A stand-in route table, not the real pages: Shell renders whichever `.element` the matched
// route carries, and a real page pulls in its own data hooks and charts, none of which this file
// needs. This isolates the assertion below to what Shell itself wires up (the rail's boundary and
// the page's), the same way `Boom` isolates the earlier tests to what `ErrorBoundary` itself does.
vi.mock('../src/routes.js', () => ({
  // A plain string, not JSX: the factory below is hoisted above every import in this file,
  // including the JSX runtime's own, so JSX here throws before the mock can even install itself.
  ROUTES: [{ path: '/', element: 'page still here' }],
}))

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

  // The rail needs its own boundary, separate from the page's, so the two degrade independently.
  // Sidebar renders as a sibling of <main> in Shell, so a throw inside it (person.slice(0, 1) on
  // a session shaped unlike what the rail expects, the real crash this mirrors) is not covered by
  // main's boundary at all and, without a boundary of its own, propagates straight out of Shell
  // and takes the whole page with it.
  it('leaves the main content standing when the rail throws', () => {
    window.history.replaceState(null, '', '/')
    // staleTime: Infinity, not just retry: false, because the seeded data alone leaves the query
    // stale from the moment it mounts, and a real ECONNREFUSED fetch to a server that is not
    // running would otherwise fire in the background regardless of what the assertion below reads.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    // A displayName Sidebar cannot call .slice on: the exact shape of session data that made the
    // rail throw for real.
    const session: Session = {
      personId: 'p1',
      displayName: null as unknown as string,
      username: 'wilma',
      isAdmin: false,
      timezone: 'Europe/Amsterdam',
    }
    client.setQueryData(queryKeys.session(), session)

    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nProvider lng="en"><Shell /></I18nProvider>
        </QueryClientProvider>,
      )
    })

    expect(container!.textContent).toContain('page still here')
  })
})
