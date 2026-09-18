// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SourceNames } from '../src/pages/settings/SourceNames.js'
import { sourceActivityKey } from '../src/data/useSourceNames.js'
import type { NamedSourceWithActivity } from '../src/data/useSourceNames.js'
import { sourcePriorityKey } from '../src/data/useSourcePriority.js'
import type { PriorityBody } from '../src/data/useSourcePriority.js'
import { flush } from './flush.js'

// Neither `renderWithProviders`/`mockApi` nor `apps/web/test/helpers.tsx` exist in this codebase:
// every other test under this directory mounts by hand with createRoot + act and seeds a fresh
// QueryClient (settings-source-names.test.tsx, source-names.test.tsx), so this file matches that
// shape rather than the two names the task brief guessed at.

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const namedSource = (over: Partial<NamedSourceWithActivity> = {}): NamedSourceWithActivity => ({
  id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4',
  alias: null, name: 'My watch', kind: 'device', createdAtMs: 0,
  lastReportedDate: '2026-02-01', reportingDates: 30, medianGapDays: 1,
  status: 'reporting', reportingNow: true,
  ...over,
})

/** Same shape as settings-source-names.test.tsx's own mountSection, plus the priority query. */
function mountSection(sources: NamedSourceWithActivity[], priority: PriorityBody): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceActivityKey(PERSON.personId), { items: sources })
  client.setQueryData(sourcePriorityKey(PERSON.personId), priority)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SourceNames /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

const orderHeadings = (): string[] =>
  [...container!.querySelectorAll('.source-order-list li')].map((li) => li.querySelector('h4')?.textContent ?? '')

const findButton = (name: RegExp): HTMLButtonElement =>
  [...container!.querySelectorAll('button')].find((b) => name.test(b.getAttribute('aria-label') ?? '')) as HTMLButtonElement

/**
 * Stands in for the real PUT route (apps/server's PUT .../source-priority): records every request
 * rather than simulating the server's own reordering, since the test only needs to see what the
 * control sent, not what a real store would answer next.
 */
function mockPriorityApi(): { restore: () => void, requests: { method: string, url: string, body: unknown }[] } {
  const requests: { method: string, url: string, body: unknown }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, url, body })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'PUT' && url.includes('/source-priority')) {
      return json(200, { configured: true, order: [] })
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

describe('the source ranking control', () => {
  it('lists every source best first, dormant included', () => {
    // A retired watch stays in the list. Omitting it would demote it below every live source,
    // which is why useSourcesWithActivity's full list feeds this section rather than the
    // live/dormant partition the card already uses for the name rows above it.
    mountSection(
      [
        namedSource({ id: 'watch', name: 'My watch', reportingNow: true }),
        namedSource({ id: 'old', name: 'Old watch', reportingNow: false }),
      ],
      {
        configured: false,
        order: [
          { sourceId: 'watch', configured: false },
          { sourceId: 'old', configured: false },
        ],
      },
    )
    expect(orderHeadings()).toEqual(['My watch', 'Old watch'])
  })

  it('moves a source up and sends the whole list', async () => {
    const client = mountSection(
      [
        namedSource({ id: 'watch', name: 'My watch', reportingNow: true }),
        namedSource({ id: 'phone', name: 'Phone', reportingNow: true }),
      ],
      {
        configured: false,
        order: [
          { sourceId: 'watch', configured: false },
          { sourceId: 'phone', configured: false },
        ],
      },
    )
    const api = mockPriorityApi()

    act(() => { findButton(/move phone up/i).click() })
    await flush(client, () => container!.innerHTML)
    api.restore()

    const put = api.requests.find((r) => r.method === 'PUT')
    expect(put?.url).toContain('/p/p1/source-priority')
    // The whole reordered list, not a patch: a partial send would demote every source it left out.
    expect(put?.body).toEqual({ sourceIds: ['phone', 'watch'] })
  })
})
