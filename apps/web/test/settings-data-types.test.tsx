// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { DataTypes } from '../src/pages/settings/DataTypes.js'
import { dataTypesKey } from '../src/data/useDataTypes.js'
import type { DataTypeChoice } from '../src/data/useDataTypes.js'
import { flush } from './flush.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, baseUrl: 'http://localhost:4235',
}

/** Builds one item the same shape the real GET answers with; tier is never asserted on below, so
 * every choice here is 'daily' rather than threading a second parameter through every call site. */
function choice(id: string, excluded: boolean): DataTypeChoice {
  return { id, tier: 'daily', excluded }
}

/**
 * Same shape as settings-source-names.test.tsx's own mountSection: a fresh QueryClient per test,
 * the session pre-seeded so useSession() never has to fetch, and the data-types query pre-seeded
 * under the same key useDataTypes/useSetDataTypes both share (dataTypesKey). An unseeded query
 * would reach the real network in this environment rather than merely running slow, so every test
 * here seeds it, the read-only ones included.
 */
function mountSection(items: DataTypeChoice[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(dataTypesKey(PERSON.personId), { items })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><DataTypes /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

const rowLabels = (): string[] =>
  [...container!.querySelectorAll('.data-type-label')].map((el) => el.textContent ?? '')

const checkedState = (): boolean[] =>
  [...container!.querySelectorAll('.data-type-row input[type="checkbox"]')]
    .map((el) => (el as HTMLInputElement).checked)

function toggle(id: string): void {
  const row = [...container!.querySelectorAll('.data-type-row')]
    .find((r) => r.querySelector('.data-type-label')?.textContent === id)
  const input = row!.querySelector('input[type="checkbox"]') as HTMLInputElement
  // A native click, not a dispatched change event: for a checkbox the click itself is what flips
  // `checked`, the same distinction annotate-panel.test.tsx's own type() helper draws for text
  // inputs (there, the native value setter; here, the native click both toggles state and fires
  // the change event React's onChange listens on).
  act(() => { input.click() })
}

/**
 * Stands in for the real route (apps/server/src/routes/v1/dataTypes.ts): GET answers whatever the
 * last PUT left behind, so the refetch a successful mutation's onSuccess triggers (dataTypesKey
 * invalidation in useDataTypes.ts) shows the new state rather than the seeded one.
 */
function mockDataTypesApi(initial: DataTypeChoice[]): {
  restore: () => void
  requests: { method: string, url: string, body: Record<string, unknown> | null }[]
} {
  let items = initial
  const requests: { method: string, url: string, body: Record<string, unknown> | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    requests.push({ method, url, body })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (method === 'GET') return json(200, { items })
    if (method === 'PUT') {
      const excluded = new Set(body!['excluded'] as string[])
      items = items.map((item) => ({ ...item, excluded: excluded.has(item.id) }))
      return json(200, { excluded: [...excluded] })
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

function lastPutBody(requests: { method: string, body: Record<string, unknown> | null }[]): unknown {
  const puts = requests.filter((r) => r.method === 'PUT')
  return puts[puts.length - 1]?.body ?? null
}

describe('the data types section', () => {
  it('shows every type, checked when it is being synced', () => {
    mountSection([choice('steps', false), choice('floors', true)])
    expect(rowLabels()).toEqual(['steps', 'floors'])
    expect(checkedState()).toEqual([true, false])
  })

  it('sends the excluded ids when one is unchecked', async () => {
    const api = mockDataTypesApi([choice('steps', false), choice('floors', false)])
    const client = mountSection([choice('steps', false), choice('floors', false)])

    toggle('steps')
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(lastPutBody(api.requests)).toEqual({ excluded: ['steps'] })
  })

  it('sends an empty list when everything is checked again', async () => {
    const api = mockDataTypesApi([choice('steps', true)])
    const client = mountSection([choice('steps', true)])

    toggle('steps')
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(lastPutBody(api.requests)).toEqual({ excluded: [] })
  })

  it('says nothing is being synced when every type is off', () => {
    mountSection([choice('steps', true), choice('floors', true)])
    expect(container!.textContent).toContain('Nothing is being synced')
  })

  // Settings hands DataTypePicker `excluded` computed straight from `items` (the server's own
  // last answer), rather than the wizard's own pending-choice state, precisely because a click
  // here mutates and invalidates immediately: the picker's checked state is a direct read of
  // server truth once that round trip settles, which is what every toggle test above already
  // exercises end to end. The multi-click-before-the-response race Finding 1 was about belongs to
  // DataTypeStep alone, which fires no mutation at all until Continue -- setup-data-types.test.tsx
  // covers it there.
})
