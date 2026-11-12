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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const OK_STATUS = {
  personId: 'p1', running: false, reason: null, startedAtMs: null, lastFinishedAtMs: 1,
  userHorizonDays: 730,
  backfill: [{ dataType: 'heart-rate', complete: false, cursorMs: null, horizonDays: 730 }],
}

class StreamStub {
  static last: StreamStub | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  constructor() { StreamStub.last = this }
  close(): void {}
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let statusGets = 0

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  navigate('/setup/backfill', { replace: true })
  sessionStorage.clear()
  sessionStorage.setItem('haelan.setup.dataTypesDone', 'true')
  statusGets = 0
  StreamStub.last = null
  vi.stubGlobal('EventSource', StreamStub)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

function stubApi(statusAnswer: { status: number, body: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/setup/state') return json(200, { step: 'done', companionMode: false })
    if (url === '/api/sync/status') {
      statusGets += 1
      return json(statusAnswer.status, statusAnswer.body)
    }
    throw new Error(`unexpected request: ${url}`)
  }))
}

function mount(): void {
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
}

describe('the setup backfill progress read', () => {
  it('sends an expired session on the progress read to sign-in', async () => {
    stubApi({ status: 401, body: { error: { kind: 'unauthorized', code: 'no_session', message: 'sign in required' } } })
    mount()
    await pumpUntil(() => container!.querySelector('h1')?.textContent === 'Sign in', 'the sign-in screen')
    const reads = statusGets
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5_100)) })
    // No poll keeps running behind the sign-in form.
    expect(statusGets).toBe(reads)
  })

  it('says the progress read failed instead of loading forever', async () => {
    stubApi({ status: 500, body: { error: { kind: 'transient', message: 'status unavailable' } } })
    mount()
    await pumpUntil(() => container!.querySelector('[role="alert"]') !== null, 'the failure')
    expect(container!.querySelector('[role="alert"]')!.textContent).toBe('status unavailable')
    expect(container!.textContent).not.toContain('Loading progress')
  })

  it('re-reads the status when a stream message is not JSON', async () => {
    stubApi({ status: 200, body: OK_STATUS })
    mount()
    await pumpUntil(() => container!.querySelector('h1')?.textContent === 'Filling in your history', 'the backfill heading')
    const reads = statusGets
    await act(async () => { StreamStub.last!.onmessage!({ data: 'not json' } as MessageEvent) })
    await pumpUntil(() => statusGets > reads, 'a fallback status read')
  })
})
