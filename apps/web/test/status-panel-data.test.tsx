// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { queryKeys } from '../src/api/queryKeys.js'
import { ApiError } from '../src/api/client.js'
import type { Session } from '../src/auth/session.js'
import {
  statusKey, useStatusPanel, useRunSync, useRefreshOnSyncFinish, useSetPanelChoice,
} from '../src/data/useStatusPanel.js'
import type { StatusPanel } from '../src/data/useStatusPanel.js'
import { sourceNamesKey, sourceActivityKey } from '../src/data/useSourceNames.js'

/**
 * The status panel's data layer, and the finished-run refresh that moved into it from SyncControl.
 *
 * The four "a finished sync" cases are carried over from sync-control.test.tsx rather than written
 * fresh: the behaviour did not change when the icon replaced the sync button, only which query
 * reports the run ending (/api/status rather than /api/sync/status) and where the effect lives. A
 * harness stands in for StatusControl, calling exactly the two hooks it calls, so these tests do
 * not depend on anything the panel draws.
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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function statusBody(running: boolean, lastFinishedAtMs: number | null, extra: Partial<StatusPanel['sync'] & object> = {}): StatusPanel {
  return {
    connections: [{ kind: 'google', lastDeliveryAtMs: lastFinishedAtMs, problem: null, devices: [] }],
    sync: { running, lastFinishedAtMs, lastRowsWritten: 0, lastFailed: 0, cooldownRemainingMs: 0, ...extra },
    problems: 0,
    hiddenDevices: 0,
  }
}

// Handed out by the harness on every render, so a test can fire a mutation without a button and
// read its settled state afterwards.
let runSync: UseMutationResult<unknown, ApiError, void> | null = null
let setChoice: ReturnType<typeof useSetPanelChoice> | null = null

function Harness() {
  const status = useStatusPanel()
  useRefreshOnSyncFinish(status.data)
  runSync = useRunSync()
  setChoice = useSetPanelChoice()
  return <span className="probe">{status.data?.sync?.running === true ? 'running' : 'idle'}</span>
}

const DATA_KEY = queryKeys.resource(PERSON.personId, 'series', { metric: 'steps' })
const OTHER_PERSON_KEY = queryKeys.resource('p2', 'series', { metric: 'steps' })

function seeded(running: boolean): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(statusKey(PERSON.personId), statusBody(running, null))
  client.setQueryData(DATA_KEY, { points: [] })
  client.setQueryData(OTHER_PERSON_KEY, { points: [] })
  return client
}

function mount(client: QueryClient): void {
  act(() => { root?.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) })
}

// The server, for the whole of each test. A 202 for the click unless a test sets runAnswer,
// serverStatus for the status route, and an empty object for anything else.
let serverStatus = statusBody(false, null)
let runAnswer: { status: number, body: unknown, headers?: Record<string, string> } = { status: 202, body: { started: true } }
let statusReads = 0
let requests: { method: string, url: string, body: unknown }[] = []
let originalFetch: typeof fetch
beforeEach(() => {
  statusReads = 0
  requests = []
  serverStatus = statusBody(false, null)
  runAnswer = { status: 202, body: { started: true } }
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    requests.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (method === 'POST' && url === '/api/sync/run') {
      return new Response(JSON.stringify(runAnswer.body), {
        status: runAnswer.status, headers: { 'content-type': 'application/json', ...runAnswer.headers },
      })
    }
    if (method === 'GET' && url === '/api/status') statusReads += 1
    const body = url === '/api/status' ? serverStatus
      : url.endsWith('/panel') ? { visible: method === 'DELETE' ? null : (JSON.parse(String(init?.body)) as { visible: boolean }).visible }
        : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

// What the next poll would write. Written directly rather than waited for; the wait is not
// optional, because react-query hands observers their notifications on a later tick.
async function pollAnswers(status: StatusPanel, client: QueryClient): Promise<void> {
  await act(async () => {
    client.setQueryData(statusKey(PERSON.personId), status)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

describe('a finished sync', () => {
  // The ordinary case: a run that outlasts one poll, started by the button, the scheduler or
  // another tab alike. Whoever started it, the poll is what sees it end.
  it('invalidates this person\'s data when the status goes from running to idle', async () => {
    const client = seeded(true)
    mount(client)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)

    await pollAnswers(statusBody(false, Date.now()), client)

    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
    // The status itself lives under the same person prefix and was just answered; invalidating it
    // too would refetch the thing that told us. Counted at the network, because the harness
    // observes the status, so an invalidation refetches at once and the flag is back to false.
    expect(statusReads).toBe(0)
    // Somebody else's cache entry, in a tab that has switched accounts, is not this run's business.
    expect(client.getQueryState(OTHER_PERSON_KEY)!.isInvalidated).toBe(false)
  })

  // The same lastFinishedAtMs answered again is not a run finishing. Without this guard every
  // status fetch would throw away every chart on the page.
  it('leaves the data alone when the same lastFinishedAtMs is read again', async () => {
    const client = seeded(false)
    client.setQueryData(statusKey(PERSON.personId), statusBody(false, 1_000))
    mount(client)
    await pollAnswers(statusBody(false, 1_000), client)
    expect(container!.querySelector('.probe')!.textContent).toBe('idle')
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)
  })

  // The bug: the panel used to notice a run only by watching running go true then false, so a
  // scheduled run this tab's five-minute idle poll never caught mid-flight - started and finished
  // between two reads - never refreshed anything. lastFinishedAtMs rising is true of every run
  // that ends, seen running or not.
  it('invalidates when lastFinishedAtMs rises without ever seeing running=true', async () => {
    const client = seeded(false)
    client.setQueryData(statusKey(PERSON.personId), statusBody(false, 1_000))
    mount(client)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)

    await pollAnswers(statusBody(false, 2_000), client)

    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
    expect(statusReads).toBe(0)
  })

  // A run with little to fetch can finish before the status re-read that follows the 202 gets its
  // answer, so the click's own success path has to notice.
  it('invalidates this person\'s data when the run is over before the status is re-read', async () => {
    serverStatus = statusBody(false, Date.now())
    const client = seeded(false)
    mount(client)
    act(() => { runSync!.mutate() })
    await settle()

    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/sync/run')).toBe(true)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
    expect(client.getQueryState(OTHER_PERSON_KEY)!.isInvalidated).toBe(false)
  })

  // The other half: a run still going when the status is re-read is left to the transition.
  it('waits for the run when the re-read after the click says it is still going', async () => {
    serverStatus = statusBody(true, null)
    const client = seeded(false)
    mount(client)
    act(() => { runSync!.mutate() })
    await settle()

    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)
    await pollAnswers(statusBody(false, Date.now()), client)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(true)
  })
})

describe('starting a sync', () => {
  // The server's sixty-second cooldown. The panel reads the status off the error to say "Synced
  // just now" rather than a failure, so the status has to survive as a number, not a message.
  it('leaves the 429 on the error as an ApiError with its status', async () => {
    runAnswer = { status: 429, body: { error: { kind: 'transient', code: 'cooldown', message: 'cooldown' } }, headers: { 'retry-after': '42' } }
    const client = seeded(false)
    mount(client)
    act(() => { runSync!.mutate() })
    await settle()

    expect(runSync!.error).toBeInstanceOf(ApiError)
    expect(runSync!.error!.status).toBe(429)
    expect(client.getQueryState(DATA_KEY)!.isInvalidated).toBe(false)
  })

  // The cached cooldownRemainingMs this button read as over is now stale - a 429 could not have
  // happened otherwise - so a re-read is what disables the button for the cooldown the server
  // just proved is still running, rather than leaving it clickable for another refusal.
  it('re-reads the status after a refused run, so the cooldown disables the button', async () => {
    runAnswer = { status: 429, body: { error: { kind: 'transient', code: 'cooldown', message: 'cooldown' } } }
    const client = seeded(false)
    serverStatus = statusBody(false, null, { cooldownRemainingMs: 45_000 })
    mount(client)
    expect(statusReads).toBe(0)
    act(() => { runSync!.mutate() })
    await settle()

    expect(statusReads).toBe(1)
    expect(client.getQueryData<StatusPanel>(statusKey(PERSON.personId))?.sync?.cooldownRemainingMs).toBe(45_000)
  })
})

describe('the panel choice', () => {
  it('sends PUT with the choice, then refreshes the panel and the source lists', async () => {
    const client = seeded(false)
    client.setQueryData(sourceActivityKey(PERSON.personId), { items: [] })
    mount(client)
    act(() => { setChoice!.mutate({ sourceId: 's1', visible: false }) })
    await settle()

    const sent = requests.filter((r) => r.url.endsWith('/panel'))
    expect(sent).toEqual([{ method: 'PUT', url: '/api/v1/p/p1/sources/s1/panel', body: { visible: false } }])
    // The activity listing is a child of sourceNamesKey, and is where panelChoice arrives; it is
    // unobserved here, so the flag stays set rather than being refetched away.
    expect(client.getQueryState(sourceActivityKey(PERSON.personId))!.isInvalidated).toBe(true)
    // The status is observed, so its invalidation shows up as a fresh read instead.
    expect(statusReads).toBe(1)
  })

  // "No choice" is the absence of a row on the server, so handing a source back to the default is
  // a DELETE with no body, not a PUT of null.
  it('sends DELETE for visible: null', async () => {
    const client = seeded(false)
    client.setQueryData(sourceNamesKey(PERSON.personId), { items: [] })
    mount(client)
    act(() => { setChoice!.mutate({ sourceId: 's1', visible: null }) })
    await settle()

    const sent = requests.filter((r) => r.url.endsWith('/panel'))
    expect(sent).toEqual([{ method: 'DELETE', url: '/api/v1/p/p1/sources/s1/panel', body: undefined }])
    expect(client.getQueryState(sourceNamesKey(PERSON.personId))!.isInvalidated).toBe(true)
    expect(setChoice!.data).toEqual({ visible: null })
  })
})
