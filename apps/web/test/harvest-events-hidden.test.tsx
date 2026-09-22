// @vitest-environment happy-dom
//
// The harvested Google recovery scores are instrumentation, not something a person recorded about
// their day, and every surface that reads events was showing them as if they were. One household's
// twenty harvested days read as twenty flagged days on the Dashboard, marked every one of those
// days on every chart, and filled the Notes page with rows nobody wrote.
//
// Asserted through `useAnnotations` rather than by calling the filter directly, because the filter
// being correct was never the risk: the risk is a surface that stops going through this hook, or a
// `select` quietly dropped from the query. A test that imports `withoutHarvest` and checks it
// filters would pass in both of those worlds.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { RECOVERY_HARVEST_EVENT_KIND } from '@haelan/core/recovery-index'
import { useAnnotations, withoutHarvest } from '../src/data/useAnnotations.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { flush } from './flush.js'
import type { Session } from '../src/auth/session.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
const realFetch = globalThis.fetch

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
  globalThis.fetch = realFetch
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// One harvested score, one event a person actually logged, on two different days. Both halves
// matter: the first is what has to disappear, the second is what must not, and a filter that threw
// everything away would satisfy an assertion that only checked for the score's absence.
const HARVESTED = { id: 'e1', kind: RECOVERY_HARVEST_EVENT_KIND, localDate: '2026-09-20', value: 52, text: null }
const REAL = { id: 'e2', kind: 'illness', localDate: '2026-09-12', value: null, text: 'Fish Potato Run' }

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let seen: string[] = []

function stubFetch(items: unknown[]): void {
  seen = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/events')) return Promise.resolve(respond({ items }))
    return Promise.resolve(respond({ items: [] }))
  }) as typeof fetch
}

let events: { id: string, kind: string }[] | undefined

function Probe(): ReactNode {
  const annotations = useAnnotations({ from: '2026-09-01', to: '2026-09-30' })
  events = annotations.events.data?.items
  return null
}

// flush(), not a hand-rolled microtask pump: the queries have to actually settle before `events`
// says anything, and a bare `await Promise.resolve()` returned while they were still in flight -
// which reads as "the filter removed everything" rather than as "nothing has arrived yet".
async function render(items: unknown[]): Promise<void> {
  stubFetch(items)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  events = undefined
  act(() => { root?.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>) })
  await flush(client, () => container?.innerHTML ?? '')
}

describe('harvested recovery scores are not a reader-facing event', () => {
  it('keeps them out of what every surface reads', async () => {
    await render([HARVESTED, REAL])
    expect(events?.map((e) => e.id)).toEqual(['e2'])
  })

  // The half that stops this from passing on a filter that drops everything.
  it('leaves an event a person actually logged alone', async () => {
    await render([REAL])
    expect(events?.map((e) => e.kind)).toEqual(['illness'])
  })

  it('still asks the server for them, so the archive and the export keep them', async () => {
    await render([HARVESTED])
    expect(seen.some((url) => url.includes('/events'))).toBe(true)
    expect(events).toEqual([])
  })

  // Keyed on the constant rather than the string, so renaming the kind in core cannot leave this
  // file asserting about a kind nothing writes any more.
  it('filters on the kind admin.ts actually writes', () => {
    expect(RECOVERY_HARVEST_EVENT_KIND).toBe('google_recovery_score')
    expect(withoutHarvest({ items: [HARVESTED, REAL] as never }).items.map((e) => e.id)).toEqual(['e2'])
  })

  // A response with no `items` at all, which the first version of this filter threw on. react-query
  // treats a throwing `select` as a FAILED query, so that turned a tolerated shape into "This did
  // not load." on the flagged days card - caught by dashboard-cards.test.tsx, which had been
  // relying on every reader's own `data?.items ?? []`. Pinned here so the tolerance is this
  // filter's stated behaviour rather than something a test elsewhere happens to depend on.
  it('survives a response carrying no items, rather than failing the query', () => {
    expect(withoutHarvest({} as never).items).toEqual([])
    expect(withoutHarvest({ items: undefined } as never).items).toEqual([])
  })
})
