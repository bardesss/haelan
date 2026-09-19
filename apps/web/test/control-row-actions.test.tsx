// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { ControlRow } from '../src/components/ControlRow.js'
import type { PageControlsState } from '../src/controls/usePageControls.js'
import { syncStatusKey } from '../src/data/useSyncStatus.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { exportPathFor } from '../src/data/pageShell.js'

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

/**
 * Mounts a tree and flushes effects, wrapped in a real I18nProvider rather than the
 * renderToStaticMarkup pattern the rest of the suite uses for static copy: this component sets
 * real click and change handlers, and those only exist once the tree is mounted for real.
 */
function mount(node: ReactNode): void {
  act(() => { root?.render(<I18nProvider lng="en">{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * ControlRow now reads the session, the sync status and the source names through TanStack Query,
 * so it needs a client in the tree the way it did not before Task 12. All three are seeded
 * directly, following dashboard-round-trip.test.tsx's pattern, rather than left to fetch: an
 * unmocked fetch to any of the three routes would be a real network call in this environment, not
 * merely a slow one. The sync status seed also keeps the button enabled for the test below that
 * clicks it.
 */
function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(syncStatusKey(PERSON.personId), {
    running: false, lastFinishedAtMs: null,
    rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] },
  })
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: [] })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

function stubControls(over: Partial<PageControlsState> = {}): PageControlsState {
  return {
    tab: 'month', anchor: '2026-08-15', source: ALL_SOURCES,
    from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31', today: '2026-08-31',
    setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
    ...over,
  }
}

// The two sync tests that opened this describe moved to sync-control.test.tsx in M10, when the
// button itself moved out of this row and into the shell.
describe('the control row actions', () => {
  // The export route answers a file. A link is the right element for that: it needs no fetch, no
  // blob and no object URL, and the browser's own download handling does the rest.
  //
  // exportPath is built through exportPathFor here, the same function every page actually calls,
  // rather than a hand typed string: a hand typed fixture cannot go wrong the way the real builder
  // did, which is exactly what let exportPathFor send `source=all` on every page's default view
  // (requireSource in packages/core/src/query/personQuery.ts knows no source by that name) through
  // four milestone reviews. stubControls' own default source is ALL_SOURCES, so this exercises
  // that exact default.
  it('offers raw download as a link to the export route, carrying the current range', () => {
    const exportPath = exportPathFor(
      'p1', ['steps'], 'sum', { from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES },
    )
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']}
      exportPath={exportPath} />))
    const link = container!.querySelector('a[href*="/export"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('format=csv')
    expect(link.getAttribute('href')).toContain('from=2026-08-01')
    // The all sources sentinel is not a source the server knows (requireSource, personQuery.ts):
    // sending it literally is the 400 this test exists to catch.
    expect(link.getAttribute('href')).not.toContain('source=')
    // One /export call takes one agg, so this link genuinely cannot carry heart rate. The label
    // names the scope it does carry rather than implying every number on the page. It is the
    // accessible name that is asserted rather than the text, because M10 made this icon only:
    // it was the longest label in the row and the rarest control in it, and it was what pushed
    // the row onto a second line on a laptop. The words have to survive that, and this is where.
    expect(link.getAttribute('aria-label')).toBe('Download daily totals')
    expect(link.getAttribute('title')).toBe('Download daily totals')
  })

  // The positive control for the assertion above: a real device name must still reach the server,
  // or refusing to ever send `source` would silently turn every device filtered download back
  // into an all sources one.
  it('carries a real source into the download link rather than always omitting it', () => {
    const exportPath = exportPathFor(
      'p1', ['steps'], 'sum', { from: '2026-08-01', to: '2026-08-31', source: 'watch' },
    )
    mount(withQuery(<ControlRow controls={stubControls({ source: 'watch' })} sources={['watch']}
      exportPath={exportPath} />))
    const link = container!.querySelector('a[href*="/export"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('source=watch')
  })

  it('offers no download link at all on a page with no export path', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} />))
    expect(container!.querySelector('a.button')).toBeNull()
  })
})
