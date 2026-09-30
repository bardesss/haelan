// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { periodKey, useActivityPeriod } from '../src/data/usePeriodRead.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { ActivityPeriodData } from '../src/data/periodTypes.js'
import type { Session } from '../src/auth/session.js'
import { flush } from './flush.js'
import { ACTIVITY_PERIOD_EMPTY, ACTIVITY_PERIOD_MONTH, ACTIVITY_PERIOD_YEAR } from './fixtures/activityPeriod.js'

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

/** Mounts a probe calling the hook; returns the request URLs it made and the data it ended with. */
async function readFor(input: { range: 'day' | 'week' | 'month' | '3months' | 'year', anchor: string, source: string }) {
  const calls: string[] = []
  let data: ActivityPeriodData | undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (req: RequestInfo | URL) => {
    const url = new URL(req instanceof Request ? req.url : String(req), 'http://localhost')
    calls.push(url.pathname + url.search)
    return new Response(JSON.stringify(ACTIVITY_PERIOD_MONTH), { status: 200 })
  }) as typeof fetch
  function Probe() {
    data = useActivityPeriod(input).data
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
  return { calls, data }
}

describe('periodKey', () => {
  it('is the resource key prefix of its kind plus range, anchor and source', () => {
    expect(periodKey('activity', 'p1', 'month', '2026-09-15', 'all'))
      .toEqual([...queryKeys.resource('p1', 'activity-period'), 'month', '2026-09-15', 'all'])
    expect(periodKey('sleep', 'p1', 'month', '2026-09-15', 'all')).not.toEqual(periodKey('activity', 'p1', 'month', '2026-09-15', 'all'))
  })
})

describe('useActivityPeriod', () => {
  it('reads /activity/period, with no source parameter for the merge', async () => {
    const { calls, data } = await readFor({ range: 'month', anchor: '2026-09-15', source: 'all' })
    expect(calls).toEqual(['/api/v1/p/p1/activity/period?range=month&anchor=2026-09-15'])
    expect(data?.workoutCount).toBe(ACTIVITY_PERIOD_MONTH.workoutCount)
  })

  it('sends a named source', async () => {
    expect((await readFor({ range: 'month', anchor: '2026-09-15', source: 'watch' })).calls)
      .toEqual(['/api/v1/p/p1/activity/period?range=month&anchor=2026-09-15&source=watch'])
  })

  it('fetches nothing on the Day tab', async () => {
    expect((await readFor({ range: 'day', anchor: '2026-09-15', source: 'all' })).calls).toEqual([])
  })
})

describe('the activity period fixtures', () => {
  it('keep the trimmed shape the route sends', () => {
    expect(ACTIVITY_PERIOD_MONTH.hero.daily.length).toBe(31)
    expect(ACTIVITY_PERIOD_MONTH.hero.weekly).toBeNull()
    expect(ACTIVITY_PERIOD_MONTH.more.every((f) => f.daily.length === 0 && f.weekly === null)).toBe(true)
    expect(ACTIVITY_PERIOD_YEAR.hero.daily.length).toBeGreaterThan(300)
    expect(ACTIVITY_PERIOD_YEAR.hero.weekly?.length).toBeGreaterThan(0)
    expect(ACTIVITY_PERIOD_YEAR.figures.every((f) => f.daily.length === 0 && f.weekly !== null)).toBe(true)
    expect(ACTIVITY_PERIOD_EMPTY.hero.days).toBe(0)
    expect(ACTIVITY_PERIOD_EMPTY.workouts).toEqual([])
  })

  it('hold a judged month hero, nine counted workouts of three types and one excluded, and a rising VO2 max', () => {
    const m = ACTIVITY_PERIOD_MONTH
    expect(m.hero.usual).not.toBeNull()
    expect(m.hero.standing).not.toBeNull()
    expect(m.workoutCount).toBe(9)
    expect(m.workouts.filter((w) => w.excluded)).toHaveLength(1)
    expect(m.workouts).toHaveLength(10)
    expect(m.types.map((t) => t.type).sort()).toEqual(['BIKING', 'RUNNING', 'WALKING'])
    expect(m.types.reduce((s, t) => s + t.count, 0)).toBe(m.workoutCount)
    expect(m.workouts.every((w) => w.sourceId === 'watch')).toBe(true)
    expect(m.vo2max?.trend).toBe('rising')
  })
})
