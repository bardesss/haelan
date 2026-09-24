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
import { SyncControl } from '../src/components/SyncControl.js'
import { syncStatusKey } from '../src/data/useSyncStatus.js'

/**
 * The sync button and its freshness line, which lived in ControlRow until M10.
 *
 * Every assertion here was carried over from control-row.test.tsx and control-row-actions.test.tsx
 * rather than written fresh, because the behaviour did not change when the control moved - only
 * where it renders. The one thing that is genuinely new is the compact spelling, which exists
 * because the phone drawer's top bar has room for about three characters beside a hamburger and a
 * wordmark.
 */

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

function mount(node: ReactNode, lng = 'en'): void {
  act(() => { root?.render(<I18nProvider lng={lng}>{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function clientWith(status?: { running: boolean, lastFinishedAtMs: number | null }): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  if (status !== undefined) {
    client.setQueryData(syncStatusKey(PERSON.personId), {
      ...status,
      rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] },
    })
  }
  return client
}

function withQuery(node: ReactNode, status: { running: boolean, lastFinishedAtMs: number | null } = { running: false, lastFinishedAtMs: null }): ReactNode {
  return <QueryClientProvider client={clientWith(status)}>{node}</QueryClientProvider>
}

/**
 * The same tree with no sync status cached and nothing answering for it, which is the state every
 * page is in for the first moment after it mounts. Separate from withQuery rather than an optional
 * argument, for the reason data-hooks.test.tsx gives: an optional parameter defaults when a caller
 * passes undefined explicitly, so a test meaning to withhold the status would quietly get it.
 */
function withQueryAwaitingStatus(node: ReactNode): ReactNode {
  return <QueryClientProvider client={clientWith()}>{node}</QueryClientProvider>
}

describe('the sync control', () => {
  // "Synced 0 min ago" reads as "synced seconds ago", and it was what a fresh instance and a
  // page still loading both printed. A missing copy string is not a reason to print a false one.
  it('says never synced rather than zero minutes ago when no run has finished', () => {
    mount(withQuery(<SyncControl />))
    expect(container!.textContent).toContain('Never synced')
    expect(container!.textContent).not.toContain('Synced 0 min ago')
  })

  it('says the status is unknown while it is still being read', () => {
    const original = globalThis.fetch
    // Never settles: this is the moment between mount and the status route answering.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    mount(withQueryAwaitingStatus(<SyncControl />))
    expect(container!.textContent).toContain('Sync status unknown')
    expect(container!.textContent).not.toContain('Never synced')
    globalThis.fetch = original
  })

  // The visible spelling is short everywhere now, so the sentence is asserted where it actually
  // lives rather than in textContent, which reads no attributes and so would pass on an element
  // that printed the words and named nothing.
  it('still reports a real time as one', () => {
    mount(withQuery(<SyncControl />, { running: false, lastFinishedAtMs: Date.now() - 7 * 60_000 }))
    expect(container!.querySelector('.synced')!.textContent).toBe('7m')
    expect(container!.querySelector('.sync-button')!.getAttribute('title')).toBe('Synced 7 min ago')
  })

  // The freshness computation moved in here from all seven pages that render a control row, each
  // of which held an identical copy of it. A clock skew or a stopped instance can put the last
  // finish in the future; a negative "synced -3 min ago" is not a thing to print.
  it('never reports a negative age', () => {
    mount(withQuery(<SyncControl />, { running: false, lastFinishedAtMs: Date.now() + 5 * 60_000 }))
    expect(container!.querySelector('.synced')!.textContent).toBe('0m')
    expect(container!.querySelector('.sync-button')!.getAttribute('title')).toBe('Synced 0 min ago')
  })

  // Three characters beside a hamburger and a wordmark. The whole sentence still has to be
  // reachable, which is what the title and the accessible name below are for.
  it('prints the age short in the phone top bar, with the sentence still on the button', () => {
    mount(withQuery(<SyncControl />, { running: false, lastFinishedAtMs: Date.now() - 14 * 60_000 }))
    expect(container!.querySelector('.synced')!.textContent).toBe('14m')
    const button = container!.querySelector('.sync-button')!
    expect(button.getAttribute('title')).toBe('Synced 14 min ago')
    expect(button.getAttribute('aria-label')).toContain('Synced 14 min ago')
    expect(button.getAttribute('aria-label')).toContain('Sync')
  })

  // A housekeeping action that runs itself on a schedule is not what a reader came to the page
  // to press, and a view gets one accent-filled control at most. This one spent it for years.
  it('is not the accent control', () => {
    mount(withQuery(<SyncControl />))
    expect(container!.querySelector('.button-primary')).toBeNull()
  })

  it('is disabled while a run is already going', () => {
    mount(withQuery(<SyncControl />, { running: true, lastFinishedAtMs: null }))
    expect((container!.querySelector('.sync-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('posts to the sync route when it is clicked', async () => {
    const posted: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(String(input))
      return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    mount(withQuery(<SyncControl />))
    const button = container!.querySelector('.sync-button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })

    globalThis.fetch = original
    expect(posted).toEqual(['/api/sync/run'])
  })

  // /api/sync/run answers 409 when a run is already going, apiSend maps 409 to its
  // setup_incomplete kind, and runSync had no onError, so a refused click did nothing at all and
  // said nothing about it.
  it('says so when a run is refused because one is already going', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: { code: 'sync_running' } }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        running: false, lastFinishedAtMs: null,
        rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] },
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    mount(withQuery(<SyncControl />))
    const button = container!.querySelector('.sync-button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = original
    expect(container!.textContent).toContain('A sync is already running.')
  })

  /**
   * The phone path, where this control used to lie.
   *
   * The sync runner only runs for people connected to Google, so a phone-only person's
   * lastFinishedAtMs is null for ever and the line read "Never synced" while their phone had been
   * uploading all week. The button beside it posts /api/sync/run, which starts that same runner and
   * has nothing to fetch for them, so the click appeared to succeed and changed nothing.
   */
  function withPhone(
    node: ReactNode,
    phone: { googleConnected: boolean, lastIngestAtMs: number | null },
    status: { running: boolean, lastFinishedAtMs: number | null } = { running: false, lastFinishedAtMs: null },
  ): ReactNode {
    const client = clientWith(status)
    client.setQueryData(queryKeys.resource(PERSON.personId, 'history-start'), {
      historyStartMs: Date.now() - 86_400_000, ...phone,
    })
    return <QueryClientProvider client={client}>{node}</QueryClientProvider>
  }

  it('says when the phone last sent instead of never synced, and offers no button', () => {
    mount(withPhone(<SyncControl />, { googleConnected: false, lastIngestAtMs: Date.now() - 20 * 60_000 }))
    expect(container!.textContent).toContain('Phone sent 20 min ago')
    expect(container!.textContent).not.toContain('Never synced')
    expect(container!.querySelector('.sync-button')).toBe(null)
  })

  it('keeps the button and says both when Google is connected as well', () => {
    // The two stall independently: a mixed household's Google sync can be healthy while the phone
    // has been asleep for a week, so one sentence carrying the newer of the two would hide it.
    mount(withPhone(
      <SyncControl />,
      { googleConnected: true, lastIngestAtMs: Date.now() - 20 * 60_000 },
      { running: false, lastFinishedAtMs: Date.now() - 5 * 60_000 },
    ))
    // Each sentence asserted where that line keeps it, which is not the same place for the two.
    // The Google line sits beside a button whose accessible name carries the whole sentence; the
    // phone line has no button, so it carries its own in an sr-only span. Both are still stated,
    // and neither is stated through the other.
    expect(container!.querySelector('.sync-button')!.getAttribute('aria-label'))
      .toContain('Synced 5 min ago')
    expect(container!.textContent).toContain('Phone sent 20 min ago')
    expect(container!.textContent).toContain('20m phone')
    expect(container!.querySelector('.sync-button')).not.toBe(null)
  })

  it('still says never synced for somebody who has connected nothing at all', () => {
    // No Google and no phone is not the phone path, it is a person who has not finished setting
    // up. "Never synced" is the true answer for them and the button is the thing that helps.
    mount(withPhone(<SyncControl />, { googleConnected: false, lastIngestAtMs: null }))
    expect(container!.textContent).toContain('Never synced')
    expect(container!.textContent).not.toContain('Phone sent')
    expect(container!.querySelector('.sync-button')).not.toBe(null)
  })
})

/**
 * A finished run refreshing the page it ran for.
 *
 * Until this, the only thing a successful click invalidated was the sync status itself, so the
 * run went, the button re-enabled, the freshness line said "0m" - and every chart and workout on
 * the page went on showing what it showed before the click until the reader reloaded. From the
 * chair that is indistinguishable from a button that does nothing, which is what it was reported
 * as.
 *
 * The data query below is seeded and never observed, so invalidating it marks it and fetches
 * nothing: isInvalidated is the whole signal, and no page component has to be mounted to read it.
 */
describe('a finished sync', () => {
  const DATA_KEY = queryKeys.resource(PERSON.personId, 'series', { metric: 'steps' })
  const OTHER_PERSON_KEY = queryKeys.resource('p2', 'series', { metric: 'steps' })

  function statusBody(running: boolean, lastFinishedAtMs: number | null) {
    return {
      running, lastFinishedAtMs, rebuildInFlight: false,
      rebuild: {
        quarantined: false, awaitingRebuild: false, producedNothing: false, droppedPages: 0,
        lastError: null, lastErrorAtMs: null, lastSuccessAtMs: null, drops: [],
      },
    }
  }

  // The server, for the whole of each test rather than around the click alone: a refresh that
  // works refetches every observed query under the person - the phone line's included - and
  // those requests must land here, not on a real socket. A 202 for the click, serverStatus for
  // the status route, and an empty object for anything else the tree happens to ask.
  let serverStatus = statusBody(false, null)
  let statusReads = 0
  let originalFetch: typeof fetch
  beforeEach(() => {
    statusReads = 0
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const posted = init?.method === 'POST'
      if (!posted && String(input) === '/api/sync/status') statusReads += 1
      const body = posted ? {} : String(input) === '/api/sync/status' ? serverStatus : {}
      return new Response(JSON.stringify(body), {
        status: posted ? 202 : 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  // What the next poll would write. Written directly rather than waited for, because the poll's
  // own wiring is sync-status.test.tsx's to guard, and three real seconds buy nothing here. The
  // wait is not optional: react-query hands observers their notifications on a later tick, so a
  // bare synchronous act() returns before the component has seen the new status at all - and the
  // idle-to-idle test below would pass on a component that never looked.
  async function pollAnswers(status: ReturnType<typeof statusBody>, client: QueryClient): Promise<void> {
    await act(async () => {
      client.setQueryData(syncStatusKey(PERSON.personId), status)
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  function seeded(running: boolean): QueryClient {
    const client = clientWith({ running, lastFinishedAtMs: null })
    client.setQueryData(DATA_KEY, { points: [] })
    client.setQueryData(OTHER_PERSON_KEY, { points: [] })
    // The phone line's query, seeded so the control asks the network for nothing on mount.
    client.setQueryData(queryKeys.resource(PERSON.personId, 'history-start'), {
      historyStartMs: null, googleConnected: true, lastIngestAtMs: null,
    })
    return client
  }

  async function click(): Promise<void> {
    const button = container!.querySelector('.sync-button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }

  // The ordinary case: a run that outlasts one poll, started by this button, the scheduler or
  // another tab alike. Whoever started it, the poll is what sees it end.
  it('invalidates this person\'s data when the status goes from running to idle', async () => {
    const client = seeded(true)
    mount(<QueryClientProvider client={client}><SyncControl /></QueryClientProvider>)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)

    await pollAnswers(statusBody(false, Date.now()), client)

    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
    // The status itself lives under the same person prefix and was just answered; invalidating it
    // too would refetch the thing that told us, for nothing. Counted at the network rather than
    // read off isInvalidated, because the control observes the status, so an invalidation of it
    // refetches at once and the flag is back to false before this line runs.
    expect(statusReads).toBe(0)
    // Somebody else's cache entry, in a tab that has switched accounts, is not this run's business.
    expect(client.getQueryState(OTHER_PERSON_KEY)!.isInvalidated).toBe(false)
  })

  // An idle status answered again is not a run finishing. Without this guard every status fetch -
  // one per mount, one per click - would throw away every chart on the page.
  it('leaves the data alone when an idle status is answered again', async () => {
    const client = seeded(false)
    mount(<QueryClientProvider client={client}><SyncControl /></QueryClientProvider>)
    await pollAnswers(statusBody(false, Date.now()), client)
    // Proof the component did see the new answer, without which the line after this proves nothing.
    expect(container!.querySelector('.synced')!.textContent).toBe('0m')
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)
  })

  // A run with little to fetch can finish before the status re-read that follows the 202 gets its
  // answer. The status then goes from idle to idle, no transition is ever observed, and the case
  // above never fires - so the click's own success path has to notice.
  it('invalidates this person\'s data when the run is over before the status is re-read', async () => {
    serverStatus = statusBody(false, Date.now())
    const client = seeded(false)
    mount(<QueryClientProvider client={client}><SyncControl /></QueryClientProvider>)
    await click()

    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
    expect(client.getQueryState(OTHER_PERSON_KEY)!.isInvalidated).toBe(false)
  })

  // The other half of the case above: a run still going when the status is re-read is left to the
  // transition, and refreshing now would only re-read data the run is about to change.
  it('waits for the run when the re-read after the click says it is still going', async () => {
    serverStatus = statusBody(true, null)
    const client = seeded(false)
    mount(<QueryClientProvider client={client}><SyncControl /></QueryClientProvider>)
    await click()

    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)
    await pollAnswers(statusBody(false, Date.now()), client)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
  })
})
