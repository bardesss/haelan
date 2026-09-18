// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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
  awaitingRebuild: boolean
  droppedPages: number
  lastError: string | null
  drops: { dataType: string, reason: string, pages: number }[]
}

const NO_REBUILD_NEWS: RebuildNews = {
  quarantined: false, awaitingRebuild: false, droppedPages: 0, lastError: null, drops: [],
}

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
      {
        quarantined: true, awaitingRebuild: true, droppedPages: 0, drops: [],
        lastError: 'UNIQUE constraint failed: samples.id',
      },
    ))
    expect(text('.maintenance-blocked')).toBe('Your data has stopped updating. A rebuild of your history did not finish, so new readings are not being collected. An administrator needs to look at this.')
    expect(text('.maintenance-download-note')).toBe('UNIQUE constraint failed: samples.id')
  })

  // The state nothing on this row could say before: their stamp is stale, sync has been skipping
  // them since the tick after they changed their timezone, and no rebuild has failed.
  it('renders the notice when the status says a rebuild is merely awaited', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} syncedMinutesAgo={4} />,
      { quarantined: false, awaitingRebuild: true, droppedPages: 0, lastError: null, drops: [] },
    ))
    expect(text('.maintenance-waiting')).toBe('Your data is waiting for a rebuild of your history, which runs at the next restart of the server. Nothing has gone wrong, and no new readings are collected until it has run.')
    expect(container!.querySelector('.maintenance-blocked')).toBeNull()
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
    awaitingRebuild: false,
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

  /**
   * The claim this card used to make about somebody whose data had stopped. A member who changes
   * their timezone carries a clean success row and a stale stamp, so quarantined and droppedPages
   * both read zero while sync skips them from the next tick - and the card, reading only those
   * two, printed "every person's history rebuilt cleanly". An operator with no reason to doubt it
   * is exactly who this branch exists to stop producing.
   */
  it('names a person awaiting a rebuild rather than calling the household clean', () => {
    mountRebuildHealth([
      person({ personId: 'p1', displayName: 'Robin', awaitingRebuild: true }),
      person({ personId: 'p2', displayName: 'Wilma' }),
    ])
    expect(text('.maintenance-waiting')).toBe('Robin is waiting for a rebuild of their history, which runs at the next restart of the server. They receive no new data until it has.')
    expect(container!.textContent).not.toContain('rebuilt cleanly')
    expect(container!.textContent).not.toContain('Wilma')
  })

  /**
   * rebuild_drops is keyed by (person_id, data_type, reason), so one data type failing two ways
   * is two rows - which is exactly what #276b's per-page isolation produces, since it groups by
   * the normalised reason. Keyed on dataType alone, React saw two children with the same key:
   * the warning is the visible half, and the reconciler reusing the wrong child across a re-render
   * is the half that reaches a reader.
   *
   * Asserted on console.error because renderToStaticMarkup never reconciles and so never warns -
   * this file's client root is the only place the check exists at all. Both rows are asserted
   * too, whole and by their own text, so a component that silently rendered one would fail here
   * rather than pass quietly.
   */
  it('keys two drops of one data type apart when only their reason differs', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mountRebuildHealth([
        person({
          personId: 'p1',
          displayName: 'Robin',
          droppedPages: 5,
          drops: [
            { dataType: 'sleep', reason: 'UNIQUE constraint failed: session_segments.id', pages: 3 },
            { dataType: 'sleep', reason: 'NOT NULL constraint failed: sessions.start_ms', pages: 2 },
          ],
        }),
      ])

      const rows = [...container!.querySelectorAll('.maintenance-download-note')]
        .map((node) => node.textContent)
      expect(rows).toContain('sleep: 3 pages, UNIQUE constraint failed: session_segments.id')
      expect(rows).toContain('sleep: 2 pages, NOT NULL constraint failed: sessions.start_ms')

      const keyWarnings = errors.mock.calls
        .map((call) => call.map(String).join(' '))
        .filter((line) => line.includes('same key'))
      expect(keyWarnings).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })
})
