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
import { RebuildHealth } from '../src/pages/settings/RebuildHealth.js'
import type { RebuildPersonState } from '../src/pages/settings/RebuildHealth.js'

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
  act(() => { root?.render(<I18nProvider lng="en">{node}</I18nProvider>) })
}

const text = (selector: string): string => container!.querySelector(selector)?.textContent ?? ''

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

interface RebuildNews {
  quarantined: boolean
  droppedPages: number
  lastError: string | null
  drops: { dataType: string, reason: string, pages: number }[]
}

const NO_REBUILD_NEWS: RebuildNews = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function stubControls(over: Partial<PageControlsState> = {}): PageControlsState {
  return {
    tab: 'month', anchor: '2026-08-15', source: ALL_SOURCES,
    from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31',
    setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
    ...over,
  }
}

/**
 * The same seeding control-row.test.tsx's own withQuery uses, so the row mounts with no real
 * fetch reached: the session, the sync status (carrying whichever `rebuild` block a case names)
 * and the source names, all of which ControlRow reads through TanStack Query.
 */
function withQuery(node: ReactNode, rebuild: RebuildNews): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(syncStatusKey(PERSON.personId), { running: false, lastFinishedAtMs: null, rebuild })
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: [] })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

describe('the control row surfaces a rebuild problem', () => {
  it('says nothing when the sync status carries no rebuild news', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} syncedMinutesAgo={4} />, NO_REBUILD_NEWS,
    ))
    expect(container!.querySelector('.maintenance')).toBeNull()
  })

  // The one behaviour this task exists to ship: a quarantine recorded on this person's own status
  // reaches their own dashboard, not only the admin's household list.
  it('renders the notice when the status carries a quarantine', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} syncedMinutesAgo={4} />,
      { quarantined: true, droppedPages: 0, lastError: 'UNIQUE constraint failed: samples.id', drops: [] },
    ))
    expect(text('.maintenance-blocked')).toBe('Your data has stopped updating. A rebuild of your history did not finish, so new readings are not being collected. An administrator needs to look at this.')
    expect(text('.maintenance-download-note')).toBe('UNIQUE constraint failed: samples.id')
  })
})

/**
 * Every field RebuildPersonState needs, defaulted so a case only names what it is actually
 * asserting on -- the same reason settings-maintenance.test.tsx's own status() helper takes
 * overrides rather than every test spelling out the whole shape.
 */
function person(overrides: Partial<RebuildPersonState>): RebuildPersonState {
  return {
    personId: 'p1',
    displayName: 'Robin',
    quarantined: false,
    droppedPages: 0,
    lastErrorAtMs: null,
    lastError: null,
    lastSuccessAtMs: 1_770_000_000_000,
    consecutiveFailures: 0,
    drops: [],
    ...overrides,
  }
}

function mountRebuildHealth(people: RebuildPersonState[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(queryKeys.session(), { ...PERSON, isAdmin: true })
  client.setQueryData(queryKeys.rebuildHealth(), { people })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><RebuildHealth /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

describe('the admin rebuild health card', () => {
  it('lists a quarantined person by name', () => {
    mountRebuildHealth([
      person({ personId: 'p1', displayName: 'Robin', quarantined: true, lastErrorAtMs: 1, lastError: 'boom' }),
      person({ personId: 'p2', displayName: 'Wilma' }),
    ])
    expect(text('.maintenance-blocked')).toBe('Robin has stopped receiving data. A rebuild of their history did not finish.')
    // Wilma is clean and must not appear beside Robin's own notice.
    expect(container!.textContent).not.toContain('Wilma')
  })

  it('says every history rebuilt cleanly when nobody is affected but rebuilds have run', () => {
    mountRebuildHealth([
      person({ personId: 'p1', displayName: 'Robin' }),
      person({ personId: 'p2', displayName: 'Wilma' }),
    ])
    expect(text('.maintenance-backups')).toBe('Every person\'s history rebuilt cleanly.')
  })

  // Distinct from the case above: nobody has ever rebuilt on this instance at all, which
  // "everyone's history rebuilt cleanly" would misstate as a fact about attempts that never
  // happened.
  it('says no rebuild has run yet when nobody on the instance has ever had one recorded', () => {
    mountRebuildHealth([
      person({ personId: 'p1', displayName: 'Robin', lastSuccessAtMs: null, lastErrorAtMs: null }),
      person({ personId: 'p2', displayName: 'Wilma', lastSuccessAtMs: null, lastErrorAtMs: null }),
    ])
    expect(text('.maintenance-backups')).toBe('No rebuild has run on this instance yet.')
  })
})
