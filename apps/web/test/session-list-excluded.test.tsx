// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SessionList } from '../src/pages/activity/SessionList.js'
import type { WorkoutSession } from '../src/data/useSessions.js'
import { ALL_SOURCES } from '../src/controls/source.js'

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

function mount(node: ReactNode, lng = 'en'): void {
  act(() => { root?.render(<I18nProvider lng={lng}>{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, baseUrl: 'http://localhost:4235',
}

const CONTROLS = {
  tab: 'month' as const, anchor: '2026-08-15', source: ALL_SOURCES,
  from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31',
  setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
}

const SESSIONS_KEY = queryKeys.resource('p1', 'sessions', {
  kind: 'exercise', from: CONTROLS.from, to: CONTROLS.to, source: CONTROLS.source,
})

// One session per row, same window and type across all of them: none of these tests reads the
// grouping or filtering machinery session-list.test.tsx already covers, only whether an excluded
// session's own row and reason line render.
const session = (id: string, over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id, sourceId: 'watch', startMs: Date.UTC(2026, 7, 3, 8, 0), endMs: Date.UTC(2026, 7, 3, 8, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: { exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 300 } },
  excluded: false, excludeReason: null,
  ...over,
})

/** Seeds the sessions response directly, so no test here depends on a network call. */
function mountList(items: WorkoutSession[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(SESSIONS_KEY, { items, cursor: null })
  mount(<QueryClientProvider client={client}><SessionList controls={CONTROLS} /></QueryClientProvider>)
}

const rowClasses = () => [...container!.querySelectorAll('.session-row')].map((r) => r.className)
const reasonText = () => [...container!.querySelectorAll('.session-row-excluded-reason')].map((r) => r.textContent)

describe('an excluded session in the activity list', () => {
  // The count card above this list drops an excluded workout at derivation; this list does not.
  // Both counted and listed still disagreeing here (one struck through, named as excluded rather
  // than dropped) is the point: a reader can see what they threw out and why, not just a lower
  // number than the list beneath it.
  it('renders the row struck through and names the reason', () => {
    mountList([
      session('s1', { excluded: false, excludeReason: null }),
      session('s2', { excluded: true, excludeReason: 'strap fell off' }),
    ])
    expect(rowClasses()).toEqual(['session-row', 'session-row session-row-excluded'])
    expect(reasonText()).toEqual(['Excluded: strap fell off'])
  })

  it('renders nothing extra when no session is excluded', () => {
    mountList([session('s1', { excluded: false, excludeReason: null })])
    expect(rowClasses()).toEqual(['session-row'])
    expect(reasonText()).toEqual([])
  })

  // excludeReason can be null even when excluded is true (a person can exclude without typing a
  // reason), and "Excluded: " with nothing after the colon would be a worse claim than the bare
  // word this falls back to instead.
  it('falls back to a bare "Excluded" when no reason was given', () => {
    mountList([session('s1', { excluded: true, excludeReason: null })])
    expect(rowClasses()).toEqual(['session-row session-row-excluded'])
    expect(reasonText()).toEqual(['Excluded'])
  })
})
