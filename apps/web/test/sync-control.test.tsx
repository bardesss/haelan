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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
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

  it('still reports a real time as one', () => {
    mount(withQuery(<SyncControl />, { running: false, lastFinishedAtMs: Date.now() - 7 * 60_000 }))
    expect(container!.textContent).toContain('Synced 7 min ago')
  })

  // The freshness computation moved in here from all seven pages that render a control row, each
  // of which held an identical copy of it. A clock skew or a stopped instance can put the last
  // finish in the future; a negative "synced -3 min ago" is not a thing to print.
  it('never reports a negative age', () => {
    mount(withQuery(<SyncControl />, { running: false, lastFinishedAtMs: Date.now() + 5 * 60_000 }))
    expect(container!.textContent).toContain('Synced 0 min ago')
  })

  // Three characters beside a hamburger and a wordmark. The whole sentence still has to be
  // reachable, which is what the title and the accessible name below are for.
  it('prints the age short in the phone top bar, with the sentence still on the button', () => {
    mount(withQuery(<SyncControl compact />, { running: false, lastFinishedAtMs: Date.now() - 14 * 60_000 }))
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
})
