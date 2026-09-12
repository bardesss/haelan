// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { WorkoutSession } from '../src/data/useSessions.js'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/activity/run1')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

export const RUN: WorkoutSession = {
  id: 'run1', sourceId: 'watch',
  startMs: Date.UTC(2026, 7, 3, 6, 0), endMs: Date.UTC(2026, 7, 3, 6, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: {
    exerciseType: 'RUNNING',
    displayName: 'Morning run',
    activeDuration: '3000s',
    exerciseMetadata: { hasGps: true },
    metricsSummary: { caloriesKcal: 412, distanceMillimeters: 8_000_000 },
  },
  excluded: false, excludeReason: null,
}

/** A session carrying nothing but its span: every optional card must be absent. */
const BARE: WorkoutSession = {
  ...RUN, id: 'bare', attrs: { exerciseType: 'WALKING' },
}

function stub(sessions: Record<string, WorkoutSession>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    for (const [id, session] of Object.entries(sessions)) {
      if (url.includes(`/sessions/${id}`)) return json(session)
    }
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sessions')) return json({ items: [], cursor: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function mount(node: ReactNode): { client: QueryClient, html: () => string } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">{node}</I18nProvider>
      </QueryClientProvider>,
    )
  })
  return { client, html: () => container?.innerHTML ?? '' }
}

describe('the workout page', () => {
  it('mounts cold at its own URL, with nothing in the query cache', async () => {
    // The case approach B exists for: no other route into this page leaves the cache empty,
    // because every one of them warms it by listing the session first.
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(html()).toContain('Morning run')
    } finally { restore() }
  })

  it('falls back to the exercise type when the workout has no name of its own', async () => {
    const restore = stub({ run1: { ...RUN, attrs: { ...(RUN.attrs as object), displayName: undefined } } })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(html()).toContain('Running')
    } finally { restore() }
  })

  it('says a route was recorded only when the session says one was', async () => {
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(container?.querySelector('.workout-gps')?.textContent).toBe(
        'A GPS route was recorded for this workout. This API does not return route points, so there is no map.',
      )
    } finally { restore() }
  })

  it('says nothing about a route when no GPS flag was recorded', async () => {
    window.history.replaceState(null, '', '/activity/bare')
    const restore = stub({ bare: BARE })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(container?.querySelector('.workout-gps')).toBeNull()
    } finally { restore() }
  })

  it('renders the excluded badge with the reason the person typed', async () => {
    const excluded = { ...RUN, excluded: true, excludeReason: 'strap slipped' }
    const restore = stub({ run1: excluded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(container?.querySelector('.workout-excluded')?.textContent)
        .toBe('Excluded: strap slipped')
    } finally { restore() }
  })

  it('renders an excluded badge without a colon when no reason was typed', async () => {
    const restore = stub({ run1: { ...RUN, excluded: true, excludeReason: null } })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(container?.querySelector('.workout-excluded')?.textContent).toBe('Excluded')
    } finally { restore() }
  })
})
