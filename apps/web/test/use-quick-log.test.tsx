// @vitest-environment happy-dom
// happy-dom: every case here mounts a tiny probe component and lets its query or mutation settle
// for real, the same reason glance-page.test.tsx does (L1-91's own comment on why).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { glanceKey } from '../src/data/useGlance.js'
import type { GlanceLog } from '../src/data/useGlance.js'
import { useGlance } from '../src/data/useGlance.js'
import {
  dayLogKey, useDayLog, useQuickLogTap, useSetMood, useSaveNote, useSavePresets,
} from '../src/data/useQuickLog.js'
import { glanceBody, glanceLog } from './glanceFixture.js'
import { flush } from './flush.js'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  birthDate: null, sex: null, sleepTargetMinutes: 480, sleepUseBaseline: true, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

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

interface Req { method: string, url: string, body: unknown }

/** Records every request and answers with `handler`'s response, or a bare 200 `{}` when the
 *  caller does not care what a request gets back. */
function stubFetch(handler?: (req: Req) => Response): { requests: Req[], restore: () => void } {
  const requests: Req[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Req = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
    }
    requests.push(req)
    if (handler) return handler(req)
    return json({})
  }) as typeof fetch
  return { requests, restore: () => { globalThis.fetch = original } }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function newClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  return client
}

function mount(client: QueryClient, node: ReactNode): void {
  act(() => { root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>) })
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('useDayLog', () => {
  function Probe({ day, initial }: { day: string, initial?: GlanceLog }): ReactNode {
    const log = useDayLog(day, initial)
    return <div data-testid="log">{JSON.stringify(log.data ?? null)}</div>
  }

  it('requests the day exactly once', async () => {
    const day = glanceLog()
    const { requests, restore } = stubFetch(() => json(day))
    const client = newClient()
    mount(client, <Probe day="2026-09-20" />)
    await flush(client, () => container!.innerHTML)
    restore()

    const toDay = requests.filter((r) => r.url.includes('/quick-log/day/2026-09-20'))
    expect(toDay).toHaveLength(1)
    expect(toDay[0]!.url).toBe('/api/v1/p/p1/quick-log/day/2026-09-20')
    expect(container!.querySelector('[data-testid="log"]')!.textContent).toBe(JSON.stringify(day))
  })

  it('requests nothing and returns the seed when given initial data', async () => {
    const initial = glanceLog({ mood: 3 })
    const { requests, restore } = stubFetch()
    const client = newClient()
    mount(client, <Probe day="2026-09-20" initial={initial} />)
    // No query is ever in flight for this probe (initialData answers it synchronously), so there
    // is nothing for flush() to wait on; a short settle is enough to let any stray fetch happen.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    restore()

    expect(requests.filter((r) => r.url.includes('/quick-log/day/'))).toHaveLength(0)
    expect(container!.querySelector('[data-testid="log"]')!.textContent).toBe(JSON.stringify(initial))
  })
})

describe('useQuickLogTap', () => {
  function Probe(): ReactNode {
    const tap = useQuickLogTap()
    return (
      <button type="button" onClick={() => tap.mutate({ kind: 'caffeine', day: '2026-09-23' })}>
        tap
      </button>
    )
  }

  function GlanceMount(): ReactNode {
    useGlance()
    return null
  }

  it('sends the tap and refetches the glance it invalidates', async () => {
    const body = glanceBody()
    const { requests, restore } = stubFetch((req) => {
      if (req.url.includes('/quick-log')) return json({ id: 'e1', kind: 'caffeine', startedAtMs: 1, localDate: '2026-09-23' })
      return json(body)
    })
    const client = newClient()
    client.setQueryData(glanceKey('p1'), body)
    mount(client, <><Probe /><GlanceMount /></>)
    await flush(client, () => container!.innerHTML)

    click(container!.querySelector('button')!)
    await flush(client, () => container!.innerHTML)
    restore()

    const posted = requests.find((r) => r.method === 'POST' && r.url.includes('/quick-log'))
    expect(posted).toBeDefined()
    expect(posted!.url).toBe('/api/v1/p/p1/quick-log')
    expect(posted!.body).toEqual({ kind: 'caffeine', day: '2026-09-23' })

    const glanceRequests = requests.filter((r) => r.url.includes('/glance') && !r.url.includes('quick-log'))
    expect(glanceRequests.length).toBeGreaterThanOrEqual(1)
  })
})

describe('useSetMood', () => {
  function Probe(): ReactNode {
    const mood = useSetMood()
    return (
      <>
        <button type="button" onClick={() => mood.mutate({ day: '2026-09-23', score: null })}>clear</button>
        <button type="button" onClick={() => mood.mutate({ day: '2026-09-23', score: 3 })}>set</button>
      </>
    )
  }

  it('deletes when the score is cleared', async () => {
    const { requests, restore } = stubFetch()
    const client = newClient()
    mount(client, <Probe />)
    click(container!.querySelectorAll('button')[0]!)
    await flush(client, () => container!.innerHTML)
    restore()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/api/v1/p/p1/moods/2026-09-23' })
  })

  it('puts the score when one is given', async () => {
    const { requests, restore } = stubFetch()
    const client = newClient()
    mount(client, <Probe />)
    click(container!.querySelectorAll('button')[1]!)
    await flush(client, () => container!.innerHTML)
    restore()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'PUT', url: '/api/v1/p/p1/moods/2026-09-23', body: { score: 3 } })
  })
})

describe('useSaveNote', () => {
  function Probe(): ReactNode {
    const note = useSaveNote()
    return (
      <>
        <button type="button" onClick={() => note.mutate({ day: '2026-09-23', body: '  ' })}>clear</button>
        <button type="button" onClick={() => note.mutate({ day: '2026-09-23', body: 'x' })}>save</button>
      </>
    )
  }

  it('deletes a note that is blank once trimmed', async () => {
    const { requests, restore } = stubFetch()
    const client = newClient()
    mount(client, <Probe />)
    click(container!.querySelectorAll('button')[0]!)
    await flush(client, () => container!.innerHTML)
    restore()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/api/v1/p/p1/notes/2026-09-23' })
  })

  it('puts a non-blank note', async () => {
    const { requests, restore } = stubFetch()
    const client = newClient()
    mount(client, <Probe />)
    click(container!.querySelectorAll('button')[1]!)
    await flush(client, () => container!.innerHTML)
    restore()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'PUT', url: '/api/v1/p/p1/notes/2026-09-23', body: { body: 'x' } })
  })

  it('puts the old note back in the cached day log when the server refuses the save', async () => {
    const { restore } = stubFetch(() => json({ error: { code: 'config', message: 'no' } }, 400))
    const client = newClient()
    client.setQueryData(dayLogKey('p1', '2026-09-23'), glanceLog({ note: 'before' }))
    mount(client, <Probe />)
    click(container!.querySelectorAll('button')[1]!)
    await flush(client, () => container!.innerHTML)
    restore()

    expect(client.getQueryData<GlanceLog>(dayLogKey('p1', '2026-09-23'))!.note).toBe('before')
  })
})

describe('useSavePresets', () => {
  function Probe(): ReactNode {
    const save = useSavePresets()
    return <button type="button" onClick={() => save.mutate(['a'])}>save</button>
  }

  it('puts the new preset list', async () => {
    const { requests, restore } = stubFetch((req) => (req.url.includes('presets') ? json({ kinds: ['a'] }) : json({})))
    const client = newClient()
    mount(client, <Probe />)
    click(container!.querySelector('button')!)
    await flush(client, () => container!.innerHTML)
    restore()

    const put = requests.find((r) => r.url.includes('presets'))
    expect(put).toMatchObject({ method: 'PUT', url: '/api/v1/p/p1/quick-log/presets', body: { kinds: ['a'] } })
  })
})
