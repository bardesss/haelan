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
 * Mounts the component with a seeded session in the QueryClient.
 */
function withSession(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

/**
 * Mounts the component with no session cached, so the query is disabled.
 */
function withoutSession(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
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

    mount(withSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

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

    mount(withoutSession(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

    globalThis.fetch = originalFetch
    // The session query itself fires exactly once. What must not fire is a glance request for
    // an undefined person, which would be a request for /api/v1/p/undefined/glance.
    const glanceRequests = fetchCalls.filter((call) => call.url.includes('/glance'))
    expect(glanceRequests).toHaveLength(0)
  })
})
