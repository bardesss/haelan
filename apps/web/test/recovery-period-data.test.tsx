// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useRecoveryPeriod, periodKey } from '../src/data/usePeriodRead.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { flush } from './flush.js'
import { RECOVERY_PERIOD_MONTH, RECOVERY_PERIOD_YEAR } from './fixtures/recoveryPeriod.js'

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
    return new Response(JSON.stringify(RECOVERY_PERIOD_MONTH), { status: 200 })
  }) as typeof fetch
  function Probe() {
    useRecoveryPeriod(input)
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

describe('periodKey for recovery', () => {
  it('is the resource key prefix plus range, anchor and source', () => {
    expect(periodKey('recovery', 'p1', 'month', '2026-09-15', 'all'))
      .toEqual([...queryKeys.resource('p1', 'recovery-period'), 'month', '2026-09-15', 'all'])
  })
})

describe('useRecoveryPeriod', () => {
  it('sends no source parameter for the merge', async () => {
    expect(await urlsFor({ range: 'month', anchor: '2026-09-15', source: 'all' }))
      .toEqual(['/api/v1/p/p1/recovery/period?range=month&anchor=2026-09-15'])
  })

  it('sends a named source', async () => {
    expect(await urlsFor({ range: 'week', anchor: '2026-09-15', source: 'watch' }))
      .toEqual(['/api/v1/p/p1/recovery/period?range=week&anchor=2026-09-15&source=watch'])
  })

  it('fetches nothing on the Day tab', async () => {
    expect(await urlsFor({ range: 'day', anchor: '2026-09-15', source: 'all' })).toEqual([])
  })
})

describe('the recovery period fixtures', () => {
  it('keep the shape the route sends', () => {
    const month = RECOVERY_PERIOD_MONTH
    expect(month.hero.metric).toBe('recovery_index')
    expect(month.hero.counts.above).toBeGreaterThan(0)
    expect(month.hero.counts.within).toBeGreaterThan(0)
    expect(month.hero.counts.below).toBeGreaterThan(0)
    expect(month.figures).toHaveLength(3)
    expect(month.carriedBy).not.toBeNull()
    expect(month.stretch?.runs.filter((r) => r.side === 'below')).toHaveLength(1)
    expect(month.stretch?.weeks).toBeNull()
    expect(month.stretch?.days.length).toBeGreaterThan(0)
    expect(month.days.length).toBeGreaterThan(0)
    const year = RECOVERY_PERIOD_YEAR
    expect(year.days).toEqual([])
    expect(year.stretch?.days).toEqual([])
    expect(year.stretch?.weeks?.length).toBeGreaterThan(0)
    expect(year.figures.every((f) => f.daily.length === 0 && f.weekly !== null)).toBe(true)
    expect(year.hero.daily.length).toBeGreaterThan(0)
  })
})
