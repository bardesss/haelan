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
import { dataTypesKey } from '../src/data/useDataTypes.js'
import type { DataTypeChoice } from '../src/data/useDataTypes.js'
import { navigate } from '../src/router.js'
import { flush, pumpUntil } from './flush.js'

// The exact heading BackfillStep renders (setup.backfill.title), pinned as a literal the same way
// setup-screens.test.tsx pins every other wizard string: these tests render with lng="en", so the
// real catalogue value is what has to show up on screen once DataTypeStep hands off.
const BACKFILL_HEADING = 'Filling in your history'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, baseUrl: 'http://localhost:4235',
}

function choice(id: string, excluded: boolean): DataTypeChoice {
  return { id, tier: 'daily', excluded }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Lands the browser exactly where the real flow does: the server redirects here itself, after
  // consent, directly to /setup/backfill (not through the SPA router), so setupStep is already
  // 'done' by the time SetupApp ever sees this URL.
  navigate('/setup/backfill', { replace: true })
  // The EventSource showBackfill opens once DataTypeStep hands off; happy-dom has no
  // implementation of its own, so without this the effect throws the instant it runs.
  vi.stubGlobal('EventSource', class {
    onmessage: ((event: MessageEvent) => void) | null = null
    close(): void {}
  })
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

/**
 * Stands in for /api/setup/state, /api/sync/status and /api/v1/p/p1/data-types together, since
 * SetupApp reaches all three as plain fetch calls (the first two through setup/api.ts's own
 * `send`, not through react-query) rather than through a seeded query. Only the data-types GET is
 * also seeded directly into the cache below, for the same reason settings-data-types.test.tsx
 * seeds it: an unseeded query reaches this mock the moment it mounts anyway, but seeding lets a
 * test that never touches the picker assert on the very first render instead of after a flush.
 */
function mockApi(initialItems: DataTypeChoice[]): {
  requests: { method: string, url: string, body: Record<string, unknown> | null }[]
  failNextPut: () => void
  restore: () => void
} {
  let items = initialItems
  let failNext = false
  const requests: { method: string, url: string, body: Record<string, unknown> | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    requests.push({ method, url, body })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (url === '/api/setup/state') return json(200, { step: 'done' })
    if (url === '/api/sync/status') {
      return json(200, {
        personId: 'p1', running: false, reason: null, startedAtMs: null, lastFinishedAtMs: 1,
        userHorizonDays: 730,
        backfill: [{ dataType: 'heart-rate', complete: false, cursorMs: null, horizonDays: 730 }],
      })
    }
    if (url.startsWith('/api/v1/p/p1/data-types')) {
      if (method === 'GET') return json(200, { items })
      if (method === 'PUT') {
        if (failNext) {
          failNext = false
          return json(500, { error: { kind: 'transient', message: 'that did not save' } })
        }
        const excluded = new Set(body!['excluded'] as string[])
        items = items.map((item) => ({ ...item, excluded: excluded.has(item.id) }))
        return json(200, { excluded: [...excluded] })
      }
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return {
    requests,
    failNextPut: () => { failNext = true },
    restore: () => { globalThis.fetch = original },
  }
}

function mount(items: DataTypeChoice[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(dataTypesKey(PERSON.personId), { items })
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

function uncheck(id: string): void {
  const row = [...container!.querySelectorAll('.data-type-row')]
    .find((r) => r.querySelector('.data-type-label')?.textContent === id)
  const input = row!.querySelector('input[type="checkbox"]') as HTMLInputElement
  act(() => { input.click() })
}

function lastPutBody(requests: { method: string, body: Record<string, unknown> | null }[]): unknown {
  const puts = requests.filter((r) => r.method === 'PUT')
  return puts[puts.length - 1]?.body ?? null
}

describe("the wizard's data type step", () => {
  it('appears after consent and before backfill', () => {
    const api = mockApi([choice('steps', false), choice('floors', false)])
    mount([choice('steps', false), choice('floors', false)])
    api.restore()

    expect(heading()).toBe('What to sync')
  })

  it('continues to backfill without a choice being made', async () => {
    const api = mockApi([choice('steps', false), choice('floors', false)])
    mount([choice('steps', false), choice('floors', false)])

    clickContinue()
    // flush() cannot be used here: nothing was saved, so onDone fires with no query or mutation
    // ever going in flight, and what showBackfill starts next (getSyncStatus, the EventSource) is
    // a plain fetch effect, not a react-query observer flush() can see. Waiting on the heading
    // itself is the thing that actually settles.
    await pumpUntil(() => heading() === BACKFILL_HEADING, 'the backfill heading to render')
    api.restore()

    expect(heading()).toBe(BACKFILL_HEADING)
    // Nothing was touched, so Continue had nothing worth saving: no PUT at all, not one repeating
    // back the same set the seeded GET already held.
    expect(lastPutBody(api.requests)).toBeNull()
  })

  it('saves a choice before continuing', async () => {
    const api = mockApi([choice('steps', false), choice('floors', false)])
    const client = mount([choice('steps', false), choice('floors', false)])

    uncheck('floors')
    clickContinue()
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(lastPutBody(api.requests)).toEqual({ excluded: ['floors'] })
  })

  // The failure this guard exists for: a wizard that cannot be finished because nobody made an
  // optional choice is worse than fetching a type somebody did not want. A choice is made here
  // (uncheck) so the PUT this fails is a real one, not a no-op Continue would have skipped anyway.
  it('continues even when the save fails', async () => {
    const api = mockApi([choice('steps', false), choice('floors', false)])
    const client = mount([choice('steps', false), choice('floors', false)])

    uncheck('floors')
    api.failNextPut()
    clickContinue()
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(heading()).toBe(BACKFILL_HEADING)
  })
})
