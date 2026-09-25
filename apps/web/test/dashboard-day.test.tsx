// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { useDashboardDay } from '../src/pages/dashboard/useDashboardDay.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Each test drives its own history, the same reset page-controls.test.tsx takes for the same
  // reason: without it a test inherits whatever the previous one navigated to.
  window.history.replaceState(null, '', '/')
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

// The session's timezone fixes what "today" and "the future" mean for this file's assertions.
// Europe/Amsterdam, UTC+2 in September, the same person page-controls.test.tsx and use-glance's
// own fixture already use.
const PERSON: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

let seen: ReturnType<typeof useDashboardDay> | null = null

function Probe() {
  seen = useDashboardDay()
  return null
}

function mountProbe(): void {
  mount(withQuery(<Probe />))
}

// The person's actual today in Amsterdam, computed the same way useDashboardDay's own `localToday`
// does - not a fixed literal, since these tests must not depend on the machine's calendar date
// happening to match one baked in here. A day well behind it is used for the "reads a day" cases
// (2020, always in the past); a day well ahead of it (2099) for the future-rejection cases.
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

describe('useDashboardDay', () => {
  it('reads a day out of ?day=', () => {
    window.history.replaceState(null, '', '/?day=2020-01-15')
    mountProbe()
    expect(seen!.day).toBe('2020-01-15')
  })

  it('is null with no ?day= at all', () => {
    window.history.replaceState(null, '', '/')
    mountProbe()
    expect(seen!.day).toBeNull()
  })

  it('writes a day to ?day= and reads it back', () => {
    window.history.replaceState(null, '', '/')
    mountProbe()
    act(() => { seen!.setDay('2020-01-15') })
    expect(window.location.search).toBe('?day=2020-01-15')
    expect(seen!.day).toBe('2020-01-15')
  })

  it('drops the parameter when the day set is today', () => {
    window.history.replaceState(null, '', '/?day=2020-01-15')
    mountProbe()
    act(() => { seen!.setDay(TODAY) })
    expect(window.location.search).toBe('')
    expect(seen!.day).toBeNull()
  })

  it('cleans a malformed ?day= with a URL replace, falling back to today', async () => {
    window.history.replaceState(null, '', '/?day=not-a-date')
    mountProbe()
    // The cleanup is an effect (there is no derived URL to fall back to in the same render), so it
    // lands after the mount's own act() flushes.
    await act(async () => { await Promise.resolve() })
    expect(window.location.search).toBe('')
    expect(seen!.day).toBeNull()
  })

  it('cleans a future ?day= with a URL replace, falling back to today', async () => {
    window.history.replaceState(null, '', '/?day=2099-01-01')
    mountProbe()
    await act(async () => { await Promise.resolve() })
    expect(window.location.search).toBe('')
    expect(seen!.day).toBeNull()
  })

  it('uses replace rather than push for the cleanup, leaving no back-button entry', async () => {
    window.history.replaceState(null, '', '/?day=2099-01-01')
    const before = window.history.length
    mountProbe()
    await act(async () => { await Promise.resolve() })
    expect(window.history.length).toBe(before)
  })
})
