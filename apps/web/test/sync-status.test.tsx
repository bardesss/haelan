// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { useSyncStatus, syncPollInterval, SYNC_POLL_MS } from '../src/data/useSyncStatus.js'

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

function Probe() {
  const status = useSyncStatus()
  return <span>{status.data?.running === true ? 'running' : 'idle'}</span>
}

const NO_REBUILD_NEWS = {
  quarantined: false, awaitingRebuild: false, droppedPages: 0, lastError: null, drops: [],
}

describe('syncPollInterval', () => {
  it('polls only while a run is going', () => {
    expect(syncPollInterval({ running: true, lastFinishedAtMs: null, rebuildInFlight: false, rebuild: NO_REBUILD_NEWS })).toBe(SYNC_POLL_MS)
    expect(syncPollInterval({ running: false, lastFinishedAtMs: 1, rebuildInFlight: false, rebuild: NO_REBUILD_NEWS })).toBe(false)
    // Nothing fetched yet is not a run: the first fetch is already on its way.
    expect(syncPollInterval(undefined)).toBe(false)
  })
})

describe('useSyncStatus', () => {
  // Once a run starts, the status used to be fetched exactly once and refreshed only when a
  // mutation succeeded, so the button stayed disabled and the label frozen for the whole run
  // while the reader watched it not change.
  it('asks again while a run is going', async () => {
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ running: true, lastFinishedAtMs: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    act(() => { root!.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const first = calls
    expect(first).toBeGreaterThan(0)
    expect(container!.textContent).toBe('running')

    // Real time rather than fake timers: react-query schedules the interval itself, and a test
    // that reaches past it into the scheduler stops standing guard on the wiring.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS + 500)) })
    expect(calls).toBeGreaterThan(first)

    globalThis.fetch = original
  })

  it('does not poll when nothing is running', async () => {
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ running: false, lastFinishedAtMs: 1 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    act(() => { root!.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    const first = calls
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS + 500)) })
    expect(calls).toBe(first)

    globalThis.fetch = original
  })
})
