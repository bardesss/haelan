// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSleepPeriod, sleepPeriodKey } from '../src/data/useSleepPeriod.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { flush } from './flush.js'
import { SLEEP_PERIOD_EMPTY, SLEEP_PERIOD_MONTH, SLEEP_PERIOD_YEAR } from './fixtures/sleepPeriod.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/** Mounts a probe calling the hook and returns the request URLs (path and query) it made. */
async function urlsFor(input: { range: 'day' | 'week' | 'month' | '3months' | 'year', anchor: string, source: string }): Promise<string[]> {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (req: RequestInfo | URL) => {
    const url = new URL(req instanceof Request ? req.url : String(req), 'http://localhost')
    calls.push(url.pathname + url.search)
    return new Response(JSON.stringify(SLEEP_PERIOD_MONTH), { status: 200 })
  }) as typeof fetch
  function Probe() {
    useSleepPeriod(input)
    return null
  }
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    act(() => { root?.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>) })
    await flush(client, () => container!.innerHTML)
  } finally {
    globalThis.fetch = originalFetch
  }
  return calls
}

describe('sleepPeriodKey', () => {
  it('is the resource key prefix plus range, anchor and source', () => {
    expect(sleepPeriodKey('p1', 'month', '2026-09-15', 'all'))
      .toEqual([...queryKeys.resource('p1', 'sleep-period'), 'month', '2026-09-15', 'all'])
  })
})

describe('useSleepPeriod', () => {
  it('sends no source parameter for the merge', async () => {
    expect(await urlsFor({ range: 'month', anchor: '2026-09-15', source: 'all' }))
      .toEqual(['/api/v1/p/p1/sleep/period?range=month&anchor=2026-09-15'])
  })

  it('sends a named source', async () => {
    expect(await urlsFor({ range: 'month', anchor: '2026-09-15', source: 'watch' }))
      .toEqual(['/api/v1/p/p1/sleep/period?range=month&anchor=2026-09-15&source=watch'])
  })

  it('fetches nothing on the Day tab', async () => {
    expect(await urlsFor({ range: 'day', anchor: '2026-09-15', source: 'all' })).toEqual([])
  })
})

describe('the sleep period fixtures', () => {
  it('keep the trimmed shape the route sends', () => {
    expect(SLEEP_PERIOD_MONTH.hero.daily.length).toBe(31)
    expect(SLEEP_PERIOD_MONTH.hero.weekly).toBeNull()
    expect(SLEEP_PERIOD_YEAR.hero.daily.length).toBeGreaterThan(300)
    expect(SLEEP_PERIOD_YEAR.hero.weekly?.length).toBeGreaterThan(0)
    expect(SLEEP_PERIOD_YEAR.figures.every((f) => f.daily.length === 0 && f.weekly !== null)).toBe(true)
    expect(SLEEP_PERIOD_MONTH.more.every((f) => f.daily.length === 0 && f.weekly === null)).toBe(true)
    expect(SLEEP_PERIOD_EMPTY.hero.days).toBe(0)
    expect(SLEEP_PERIOD_EMPTY.nights).toEqual([])
  })
})
