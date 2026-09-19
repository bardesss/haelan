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
  producedNothing: boolean
  lastError: string | null
  // Both null by default in NO_REBUILD_NEWS below: dating a quarantine or a drop is what this
  // task adds, and a case that is not about it should not have to name either field.
  lastErrorAtMs: number | null
  lastSuccessAtMs: number | null
  drops: { dataType: string, reason: string, pages: number }[]
}

const NO_REBUILD_NEWS: RebuildNews = {
  quarantined: false, awaitingRebuild: false, droppedPages: 0, producedNothing: false,
  lastError: null, lastErrorAtMs: null, lastSuccessAtMs: null, drops: [],
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
 *
 * rebuildInFlight is seeded beside `rebuild` rather than inside it, which is where the runner
 * puts it: whether the boot rebuild worker is running is one fact about the process, not one
 * per household member. It defaults to false so a case only names it when that is the axis it
 * is about.
 */
function withQuery(node: ReactNode, rebuild: RebuildNews, rebuildInFlight = false): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(syncStatusKey(PERSON.personId), {
    running: false, lastFinishedAtMs: null, rebuild, rebuildInFlight,
  })
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: [] })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

describe('the control row surfaces a rebuild problem', () => {
  it('says nothing when the sync status carries no rebuild news', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} />, NO_REBUILD_NEWS,
    ))
    expect(container!.querySelector('.maintenance')).toBeNull()
  })

  // The one behaviour this task exists to ship: a quarantine recorded on this person's own status
  // reaches their own dashboard, not only the admin's household list.
  it('renders the notice when the status carries a quarantine', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} />,
      {
        quarantined: true, awaitingRebuild: true, droppedPages: 0, producedNothing: false, drops: [],
        lastError: 'UNIQUE constraint failed: samples.id', lastErrorAtMs: null, lastSuccessAtMs: null,
      },
    ))
    expect(text('.maintenance-blocked')).toBe('Your data has stopped updating. A rebuild of your history did not finish, so new readings are not being collected. An administrator needs to look at this.')
    expect(text('.maintenance-download-note')).toBe('UNIQUE constraint failed: samples.id')
  })

  /**
   * The end-to-end path this task adds: useSyncStatus.ts's SyncStatus.rebuild did not carry
   * lastErrorAtMs at all before this, so ControlRow's spread of status.data.rebuild into
   * RebuildNotice silently dropped it and every quarantine on this row rendered undated. Checked
   * here rather than only on RebuildNotice's own suite, which proves the wording is right but not
   * that the fetched status actually reaches the prop that picks it.
   */
  it('dates the quarantine on the control row from the failure time the status carries', () => {
    const now = Date.now()
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} />,
      {
        quarantined: true, awaitingRebuild: true, droppedPages: 0, producedNothing: false, drops: [],
        lastError: 'UNIQUE constraint failed: samples.id',
        lastErrorAtMs: now - 3 * 60 * 60 * 1000, lastSuccessAtMs: null,
      },
    ))
    expect(text('.maintenance-blocked')).toBe('Your data has stopped updating. A rebuild of your history failed 3 hours ago, so new readings are not being collected. An administrator needs to look at this.')
  })

  // The state nothing on this row could say before: their stamp is stale, sync has been skipping
  // them since the tick after they changed their timezone, and no rebuild has failed.
  it('renders the notice when the status says a rebuild is merely awaited', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} />,
      {
        quarantined: false, awaitingRebuild: true, droppedPages: 0, producedNothing: false, lastError: null,
        lastErrorAtMs: null, lastSuccessAtMs: null, drops: [],
      },
    ))
    expect(text('.maintenance-waiting')).toBe('Your data is waiting for a rebuild of your history, which runs at the next restart of the server. Nothing has gone wrong, and no new readings are collected until it has run.')
    expect(container!.querySelector('.maintenance-blocked')).toBeNull()
  })

  /**
   * The same person, the same stale stamp, during the boot rebuild that is fixing it. The server
   * listens before that rebuild starts and the rebuild can run for fifteen minutes, so this is
   * the state a reader most often lands on right after an upgrade - and the sentence above,
   * rendered here, would send them to restart the container and abort the run.
   *
   * Asserted through the whole row rather than on RebuildNotice alone, because the flag has to
   * survive the trip from the route's envelope to a prop: ControlRow spreads status.data.rebuild
   * into the notice, and rebuildInFlight is deliberately not in that object.
   */
  it('tells the person a rebuild is running now while the boot rebuild is in flight', () => {
    mount(withQuery(
      <ControlRow controls={stubControls()} sources={['watch']} />,
      {
        quarantined: false, awaitingRebuild: true, droppedPages: 0, producedNothing: false, lastError: null,
        lastErrorAtMs: null, lastSuccessAtMs: null, drops: [],
      },
      true,
    ))
    expect(text('.maintenance-waiting')).toBe('Your data is waiting for a rebuild of your history, which is running now. Nothing has gone wrong, and no new readings are collected until it finishes, which it will do on its own.')
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
    producedNothing: false,
    lastErrorAtMs: null,
    lastError: null,
    lastSuccessAtMs: 1_770_000_000_000,
    consecutiveFailures: 0,
    drops: [],
    ...overrides,
  }
}

function mountRebuildHealth(people: RebuildPersonState[], rebuildInFlight = false): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(queryKeys.session(), { ...PERSON, isAdmin: true })
  client.setQueryData(queryKeys.rebuildHealth(), { people, rebuildInFlight })
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
      // lastErrorAtMs left null on purpose: this test is about the listing, not the date, and a
      // non-null value here would print "failed ... ago" instead of the plain sentence asserted
      // below - the dated wording gets its own test right after this one.
      person({ personId: 'p1', displayName: 'Robin', quarantined: true, lastErrorAtMs: null, lastError: 'boom' }),
      person({ personId: 'p2', displayName: 'Wilma' }),
    ])
    expect(text('.maintenance-blocked')).toBe('Robin has stopped receiving data. A rebuild of their history did not finish.')
    // Wilma is clean and must not appear beside Robin's own notice.
    expect(container!.textContent).not.toContain('Wilma')
  })

  /**
   * The admin card's own copy of the plumbing check above: routes/maintenance.ts already returned
   * lastErrorAtMs before this task, but nothing had ever asked RebuildHealth.tsx to pass it on to
   * RebuildNotice, so a quarantine on this card rendered undated regardless of what the route sent.
   */
  it('dates a quarantined person\'s notice from the failure time the route carries', () => {
    const now = Date.now()
    mountRebuildHealth([
      person({
        personId: 'p1', displayName: 'Robin', quarantined: true,
        lastErrorAtMs: now - 3 * 24 * 60 * 60 * 1000, lastError: 'boom',
      }),
    ])
    expect(text('.maintenance-blocked')).toBe('Robin has stopped receiving data. A rebuild of their history failed 3 days ago.')
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
   * The operator's copy of the same correction. This card is the surface an administrator reads
   * right after an upgrade, which is exactly when the boot rebuild is in flight and everybody it
   * has not reached yet is listed here - and telling the one person who can restart the container
   * that a restart is the remedy is how the rebuild gets killed halfway through.
   *
   * One flag on the envelope drives every row, which is the point of putting it there: one
   * worker rebuilds the whole household in a single pass, so two rows cannot disagree about
   * whether it is running.
   */
  it('tells the operator a rebuild is running now rather than to restart the server', () => {
    mountRebuildHealth([person({ personId: 'p1', displayName: 'Robin', awaitingRebuild: true })], true)
    expect(text('.maintenance-waiting')).toBe('Robin is waiting for a rebuild of their history, which is running now. They receive no new data until it finishes, which it will do on its own.')
  })

  /**
   * The last route to "every person's history rebuilt cleanly" being said over somebody's head.
   * A rebuild that read an archive and wrote nothing commits, drops no page and records no
   * error, so on the three flags this filter read before, that person was clean - and the card
   * said so about a member with empty pages.
   */
  it('names a person whose rebuild produced nothing rather than calling the household clean', () => {
    mountRebuildHealth([
      // lastSuccessAtMs left null, for the same reason the quarantine listing test above does:
      // this is about the listing, not the date, which gets its own test on RebuildNotice's suite.
      person({ personId: 'p1', displayName: 'Robin', producedNothing: true, lastSuccessAtMs: null }),
      person({ personId: 'p2', displayName: 'Wilma' }),
    ])
    expect(text('.maintenance-waiting')).toBe('Robin\'s history was rebuilt without any error, but it produced no readings, so their pages are empty. Nothing has been deleted: everything ever collected for them is still stored, and a later version may be able to read it.')
    expect(container!.textContent).not.toContain('rebuilt cleanly')
    expect(container!.textContent).not.toContain('Wilma')
  })

  // The false alarm the payload count removes, asserted where an operator would actually meet
  // it. A household of new members replays to no rows at all, and a card that listed every one
  // of them is a card its one reader stops reading.
  it('still calls the household clean when nobody\'s rebuild had an archive to read', () => {
    mountRebuildHealth([
      person({ personId: 'p1', displayName: 'Robin' }),
      person({ personId: 'p2', displayName: 'Wilma' }),
    ])
    expect(text('.maintenance-backups')).toBe('Every person\'s history rebuilt cleanly.')
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
