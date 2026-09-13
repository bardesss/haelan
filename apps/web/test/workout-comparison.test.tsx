// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkoutComparisonCard } from '../src/pages/activity/WorkoutComparison.js'
import { comparisonRange, useWorkoutComparison } from '../src/data/useWorkoutComparison.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'

describe('the comparison window', () => {
  it('is the ninety days ending at this workout\'s own local date', () => {
    expect(comparisonRange('2026-08-03')).toEqual({ from: '2026-05-05', to: '2026-08-03' })
  })
})

describe('the comparison card', () => {
  it('states a count, not a rank', () => {
    const html = renderToStaticMarkup(<WorkoutComparisonCard comparison={{
      exerciseType: 'RUNNING', of: 12, reason: null,
      pace: { better: 8, of: 12 }, heartRate: null, distance: { better: 4, of: 12 },
    }} isPending={false} isError={false} />)
    expect(html).toContain('activity.workout.comparison.pace')
    expect(html).not.toContain('activity.workout.comparison.rank')
  })

  it('withholds itself with its own reason when there are too few prior workouts', () => {
    const html = renderToStaticMarkup(<WorkoutComparisonCard comparison={{
      exerciseType: 'RUNNING', of: 2, reason: 'too-few', pace: null, heartRate: null, distance: null,
    }} isPending={false} isError={false} />)
    expect(html).toContain('activity.workout.comparison.tooFew')
  })

  it('renders no card at all when the workout has no type to compare within', () => {
    expect(renderToStaticMarkup(<WorkoutComparisonCard comparison={{
      exerciseType: null, of: 0, reason: 'no-type', pace: null, heartRate: null, distance: null,
    }} isPending={false} isError={false} />)).toBe('')
  })
})

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
  birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/** Seeded synchronously, the way data-hooks.test.tsx's own withSession does: no /api/auth/me
 *  request happens either, so the fetch mock in the tests below counts and names only what
 *  useWorkoutComparison itself asks for. */
function withSession(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

// Review finding on this task: the guard against fetching an empty `{ from: '', to: '' }` range
// while `session` is undefined lived entirely in caller discipline (WorkoutComparison.tsx's own
// session prop being required). Nothing stopped a future direct caller of the exported
// `useWorkoutComparison(session: WorkoutSession | undefined)` from reintroducing a request for
// `?kind=exercise&from=&to=`. `enabled: session !== undefined` is now threaded into the
// useSessions call inside the hook itself, mirroring useIntradayWindow's own options.enabled
// (data-hooks.test.tsx's own three-part shape for that hook is the model these two tests follow).
describe('the comparison hook\'s request guard', () => {
  it('makes no sessions request while the session has not resolved', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch

    function Probe() {
      useWorkoutComparison(undefined)
      return null
    }
    act(() => { root?.render(withSession(<Probe />)) })
    // The session is seeded, not fetched, so there is no real request here to wait out the way
    // flush() does - a fixed pump past the microtask queue is what tells "never ran" apart from
    // "has not run yet", the same reasoning data-hooks.test.tsx's own guard tests use.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    // Nothing at all should reach the fetch mock: not the session (already cached) and not a
    // sessions request for the empty `{ from: '', to: '' }` range an unresolved session produces.
    expect(calls).toBe(0)
  })

  it('fetches the sessions window exactly once a session is passed', async () => {
    let calls = 0
    let lastUrl: string | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1
      lastUrl = String(input)
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200 })
    }) as typeof fetch

    function Probe() {
      useWorkoutComparison({
        id: 'run1', sourceId: 'watch', startMs: 0, endMs: 0, startOffsetMinutes: 0, endOffsetMinutes: 0,
        localDate: '2026-08-03', attrs: {}, excluded: false, excludeReason: null,
      })
      return null
    }
    act(() => { root?.render(withSession(<Probe />)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    globalThis.fetch = originalFetch
    expect(calls).toBe(1)
    expect(lastUrl).toContain('/api/v1/p/p1/sessions')
    expect(lastUrl).toContain('from=2026-05-05')
    expect(lastUrl).toContain('to=2026-08-03')
  })
})
