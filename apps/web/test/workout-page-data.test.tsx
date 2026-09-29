// @vitest-environment happy-dom
//
// Same shape as night-page-data.test.tsx: useWorkoutPage calls useSession() and useQuery(), both
// real React hooks, so exercising it needs a mounted tree. `workoutPageKey` itself is a plain
// function and is asserted directly, with no tree at all.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useWorkoutPage, workoutPageKey } from '../src/data/useWorkoutPage.js'
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

describe('workoutPageKey', () => {
  it('is the resource key prefix plus the session id', () => {
    expect(workoutPageKey('p1', 's1')).toEqual([...queryKeys.resource('p1', 'workout'), 's1'])
  })
})

describe('useWorkoutPage', () => {
  it('requests the workout page for the resolved person and the given session', async () => {
    const fetchCalls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      fetchCalls.push(url.pathname)
      return new Response(JSON.stringify({ sessionId: 's1' }), { status: 200 })
    }) as typeof fetch

    function Probe() {
      useWorkoutPage('s1')
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

    expect(fetchCalls).toEqual(['/api/v1/p/p1/workout/s1'])
  })

  it('makes no request until both the person and the session id have resolved', async () => {
    const fetchCalls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      fetchCalls.push(url.pathname)
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useWorkoutPage(undefined)
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

    expect(fetchCalls.some((path) => path.includes('/workout/'))).toBe(false)
  })
})
