// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
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

/**
 * Answers the session request with an HTTP status rather than a session, everything else as
 * `stub` above. Used for the error and not-found branches: `stub` can only ever answer 200, since
 * every id absent from its `sessions` map falls through to the generic `/sessions` list route
 * (also matched by `.includes('/sessions')`) rather than 404ing the way a real miss on
 * `/sessions/:id` does.
 */
function stubSessionError(status: number): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown, responseStatus = 200) =>
      new Response(JSON.stringify(body), { status: responseStatus, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sessions/run1')) return json({}, status)
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

  // Review finding on this task: Shell renders `active.element` straight into `.main`, which
  // carries no card background of its own (unlike SessionList.tsx's hand-rolled states, always
  // inside a Card its caller Activity.tsx already supplies), so all three of this page's own
  // states have to bring their own Card or render as unstyled floating text. These three cases are
  // exactly what the review found nothing here exercising.
  it('shows the loading state inside a card, not as floating text, before the session request settles', () => {
    const restore = stub({ run1: RUN })
    try {
      // No flush: read the tree as it stands on the very first synchronous render, before the
      // stubbed fetch above has had any chance to resolve - the cold-load window the review found.
      const { html } = mount(<WorkoutDetail />)
      expect(container?.querySelector('.card .empty')).not.toBeNull()
      expect(html()).toContain('Loading')
    } finally { restore() }
  })

  it('wraps the missing-workout state in a card too, for a link naming a session that is not there', async () => {
    const restore = stubSessionError(404)
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(container?.querySelector('.card .empty')).not.toBeNull()
      expect(html()).toContain('No such workout')
    } finally { restore() }
  })

  it('wraps a real request failure in a card too, with a retry', async () => {
    const restore = stubSessionError(500)
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await flush(client, html)
      expect(container?.querySelector('.card .empty')).not.toBeNull()
      expect(html()).toContain('This did not load.')
    } finally { restore() }
  })
})
