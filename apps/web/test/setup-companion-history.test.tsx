// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SetupApp } from '../src/setup/SetupApp.js'
import { navigate } from '../src/router.js'
import { pumpUntil } from './flush.js'

// The exact headings CompanionHistoryStep renders (setup.companionHistory.*), pinned as
// literals the way setup-data-types.test.tsx pins BACKFILL_HEADING: these tests render
// with lng="en", so the real catalogue values are what has to show up on screen.
const HISTORY_HEADING = 'Your history starts here'
const BACKFILL_HEADING = 'Filling in your history'
const DATA_TYPES_HEADING = 'What to sync'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  navigate('/setup/backfill', { replace: true })
  vi.stubGlobal('EventSource', class {
    onmessage: ((event: MessageEvent) => void) | null = null
    close(): void {}
  })
  sessionStorage.clear()
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

/**
 * Stands in for /api/setup/state, /api/v1/p/p1/data-types and
 * /api/v1/p/p1/companion/cursors together. /api/sync/status is deliberately
 * absent: on the companion path nothing must ever ask for Google sync progress,
 * and this mock throws on any request it was not told to expect.
 */
function mockApi(companionMode: boolean, historyStartMs: number | null): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/setup/state') return json(200, { step: 'done', companionMode })
    if (url === '/api/sync/status') {
      return json(200, {
        personId: 'p1', running: false, reason: null, startedAtMs: null, lastFinishedAtMs: 1,
        userHorizonDays: 730,
        backfill: [{ dataType: 'heart-rate', complete: false, cursorMs: null, horizonDays: 730 }],
      })
    }
    if (url === '/api/v1/p/p1/data-types') {
      if (method === 'PUT') return json(200, { excluded: [] })
      return json(200, { items: [] })
    }
    if (url.startsWith('/api/v1/p/p1/companion/cursors')) {
      return json(200, { items: [], historyStartMs, googleConnected: false })
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function mount(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SetupApp /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

const heading = (): string | null => container!.querySelector('h1')?.textContent ?? null

function clickContinue(): void {
  const button = [...container!.querySelectorAll('button')].find((b) => b.textContent === 'Continue')
  act(() => { button!.click() })
}

describe("the wizard's companion history step", () => {
  // T6.4: a phone-only instance walks the wizard without ever seeing the data types
  // step either. Exclusions govern what the instance fetches from Google, and a
  // phone-only history fetches nothing, so SetupApp skips the screen instead of
  // filtering its list. No click needed: the history step is where the wizard lands
  // on its own, and the backfill step never shows.
  it('skips the data types step on a companion instance', async () => {
    const restore = mockApi(true, null)
    mount()

    await pumpUntil(() => heading() === HISTORY_HEADING, 'the history heading to render')
    restore()

    expect(heading()).toBe(HISTORY_HEADING)
    expect(container!.textContent).not.toContain(DATA_TYPES_HEADING)
    expect(container!.textContent).not.toContain(BACKFILL_HEADING)
  })

  // The date half of the same step: a history that already started names when, which is
  // the T5.3 date this step stands in for rather than a horizon to pick.
  it('names the date once the phone has sent', async () => {
    const restore = mockApi(true, Date.parse('2026-09-13T10:00:00Z'))
    mount()

    clickContinue()
    // The heading renders before the history answer lands, so waiting on it alone
    // would assert while the step still shows its loading line.
    await pumpUntil(() => container!.textContent!.includes('2026-09-13'), 'the history date to render')
    restore()

    expect(container!.textContent).toContain('2026-09-13')
  })

  // Passo 2: the Google path is untouched, horizon question included.
  it('keeps the backfill step on a Google instance', async () => {
    const restore = mockApi(false, null)
    mount()

    expect(heading()).toBe(DATA_TYPES_HEADING)
    clickContinue()
    await pumpUntil(() => heading() === BACKFILL_HEADING, 'the backfill heading to render')
    restore()

    expect(heading()).toBe(BACKFILL_HEADING)
    expect(container!.textContent).not.toContain(HISTORY_HEADING)
  })

  // The history step is information, not a dead end: whoever already synced on
  // another screen still needs a way on to the dashboard from here.
  it('offers a way on to the dashboard from the history step', async () => {
    const restore = mockApi(true, null)
    mount()

    await pumpUntil(() => heading() === HISTORY_HEADING, 'the history heading to render')
    restore()

    expect(container!.querySelector('a[href="/"]')?.textContent).toBe('Go to the dashboard')
  })

  // The companion exit lands on done while the browser still shows the Google step:
  // without a navigate the finished wizard sits on that step's working state, and the
  // button that was clicked reads "saving" forever. Found by clicking it on a real
  // instance rather than in a test.
  it('leaves the Google step for the history step once companion setup finishes', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
      if (url === '/api/setup/state') return json(200, { step: 'done', companionMode: true })
      if (url.startsWith('/api/setup/redirect-uris')) return json(200, { candidates: [] })
      if (url === '/api/setup/scopes') return json(200, { scopes: [] })
      if (url.startsWith('/api/v1/p/p1/companion/cursors')) {
        return json(200, { items: [], historyStartMs: null, googleConnected: false })
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }) as typeof fetch
    navigate('/setup/google', { replace: true })
    mount()

    await pumpUntil(() => heading() === HISTORY_HEADING, 'the history heading to render after the companion exit')
    globalThis.fetch = original

    expect(heading()).toBe(HISTORY_HEADING)
  })
})
