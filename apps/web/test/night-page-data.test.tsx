// @vitest-environment happy-dom
//
// Deviation from the brief's suggested `.test.ts` name: useNightPage calls useSession() and
// useQuery(), both real React hooks, so exercising it needs a mounted tree the way every other
// data-hook test in this suite does (data-hooks.test.tsx, use-glance.test.tsx) - a bare
// QueryObserver only reaches a query with no hook dependencies of its own (sign-out-request.test.ts's
// pattern), which useNightPage is not. `nightPageKey` itself is a plain function and is asserted
// directly, with no tree at all.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useNightPage, nightPageKey } from '../src/data/useNightPage.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
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

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withClient(node: ReactNode, session: boolean): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (session) client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

describe('nightPageKey', () => {
  it('is the resource key prefix plus the local date', () => {
    expect(nightPageKey('p1', '2026-09-06')).toEqual([...queryKeys.resource('p1', 'night'), '2026-09-06'])
  })
})

describe('useNightPage', () => {
  it('requests the night page for the resolved person and the given date', async () => {
    const fetchCalls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      fetchCalls.push(url.pathname)
      return new Response(JSON.stringify({ localDate: '2026-09-06' }), { status: 200 })
    }) as typeof fetch

    function Probe() {
      useNightPage('2026-09-06')
      return null
    }

    try {
      const { client, tree } = withClient(<Probe />, true)
      mount(tree)
      await flush(client, () => container!.innerHTML)
    } finally {
      // Put back even when the flush throws, or every later test in this worker inherits the stub.
      globalThis.fetch = originalFetch
    }

    expect(fetchCalls).toEqual(['/api/v1/p/p1/night/2026-09-06'])
  })

  it('makes no request until both the person and the date have resolved', async () => {
    const fetchCalls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      fetchCalls.push(url.pathname)
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useNightPage(undefined)
      return null
    }

    try {
      const { client, tree } = withClient(<Probe />, true)
      mount(tree)
      await flush(client, () => container!.innerHTML)
    } finally {
      // Put back even when the flush throws, or every later test in this worker inherits the stub.
      globalThis.fetch = originalFetch
    }

    expect(fetchCalls.some((path) => path.includes('/night/'))).toBe(false)
  })
})
