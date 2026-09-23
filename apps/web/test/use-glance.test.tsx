// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useGlance } from '../src/data/useGlance.js'
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

/** Mounts a tree and flushes effects. Every render in these tests goes through act. */
function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * The component inside a fresh QueryClient, with the person's session seeded or not. The client
 * comes back with the tree so a test can flush() on it: waiting on the queries themselves, rather
 * than on a fixed 50ms that a loaded machine can outrun, is what makes a pass here mean the request
 * settled and a "no request" mean the session query settled without one.
 */
function withClient(node: ReactNode, session: boolean): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (session) client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

describe('useGlance', () => {
  it('fetches the glance payload and returns it', async () => {
    const fetchCalls: Array<{ url: string, method: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      fetchCalls.push({ url: url.toString(), method: input instanceof Request ? input.method : 'GET' })
      return new Response(JSON.stringify({
        today: '2026-08-15',
        sleep: null,
        recovery: {
          index: {
            metric: 'recovery_index',
            value: 75,
            unit: 'score',
            baseline: null,
            asOfDate: '2026-08-15',
            asOfMs: null,
            partial: false,
            staleSources: [],
            strip: [],
          },
          band: 'usual',
          missing: null,
          restingHeartRate: {
            metric: 'resting_heart_rate',
            value: 60,
            unit: 'bpm',
            baseline: null,
            asOfDate: '2026-08-15',
            asOfMs: null,
            partial: false,
            staleSources: [],
            strip: [],
          },
          hrv: {
            metric: 'daily_hrv',
            value: 50,
            unit: 'ms',
            baseline: null,
            asOfDate: '2026-08-15',
            asOfMs: null,
            partial: false,
            staleSources: [],
            strip: [],
          },
          respiratoryRate: null,
        },
        day: {
          steps: {
            metric: 'steps',
            value: 5000,
            unit: 'steps',
            baseline: null,
            asOfDate: '2026-08-15',
            asOfMs: null,
            partial: true,
            staleSources: [],
            strip: [],
          },
          activeMinutes: {
            metric: 'active_minutes',
            value: 30,
            unit: 'minutes',
            baseline: null,
            asOfDate: '2026-08-15',
            asOfMs: null,
            partial: true,
            staleSources: [],
            strip: [],
          },
          heartRate: {
            points: [],
            asOfMs: null,
            staleSources: [],
          },
        },
      }), { status: 200 })
    }) as typeof fetch

    function Probe() {
      const { glance } = useGlance()
      if (glance) {
        return <div data-testid="glance">{glance.today}</div>
      }
      return <div data-testid="pending">pending</div>
    }

    const { client, tree } = withClient(<Probe />, true)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    globalThis.fetch = originalFetch

    // Should have requested the glance endpoint
    const glanceRequests = fetchCalls.filter((call) => call.url.includes('/api/v1/p/p1/glance'))
    expect(glanceRequests).toHaveLength(1)

    // Should render the glance data
    const glanceEl = container?.querySelector('[data-testid="glance"]')
    expect(glanceEl?.textContent).toBe('2026-08-15')
  })

  it('does not fetch until the session has resolved a person', async () => {
    const fetchCalls: Array<{ url: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      fetchCalls.push({ url: url.toString() })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    function Probe() {
      useGlance()
      return null
    }

    const { client, tree } = withClient(<Probe />, false)
    mount(tree)
    // Settled means the session query came back, which is the moment a glance request would have
    // been issued had the hook not waited for a person.
    await flush(client, () => container!.innerHTML)
    expect(fetchCalls.some((call) => call.url.includes('/api/auth/me'))).toBe(true)

    globalThis.fetch = originalFetch
    // The session query itself fires exactly once. What must not fire is a glance request for
    // an undefined person, which would be a request for /api/v1/p/undefined/glance.
    const glanceRequests = fetchCalls.filter((call) => call.url.includes('/glance'))
    expect(glanceRequests).toHaveLength(0)
  })
})
