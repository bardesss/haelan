// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { FlaggedDaysCard } from '../src/pages/notes/FlaggedDaysCard.js'
import { Notes } from '../src/pages/Notes.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

const RANGE = { from: '2026-08-01', to: '2026-08-31' }

/**
 * Answers every route FlaggedDaysCard (and, mounted on Notes, NotesList beside it) calls:
 * /events with the given items, /notes and /overrides in the real `{ items: [] }` shape, and a
 * quiet sync status. Mirrors dashboard-cards.test.tsx's own stubFetchWithEvents, which this card
 * used to be read against before it moved.
 */
function stubFetchWithEvents(items: unknown[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/events')) return json({ items })
    if (url.includes('/notes')) return json({ items: [] })
    if (url.includes('/overrides')) return json({ items: [] })
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the flagged days card', () => {
  // Zero flagged days in the period is the honest empty state ("nothing is flagged"), not the old
  // false one ("nothing connected reports events"): M3c made the reader the source of events, and
  // this card reads useAnnotations(range).events itself now.
  it('reports no events for the period rather than claiming nothing is connected', async () => {
    const restore = stubFetchWithEvents([])
    const { client, tree } = withQuery(<FlaggedDaysCard range={RANGE} span={4} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Flagged days')
    expect(card?.querySelector('.empty')?.textContent).toContain('No flagged days in this period.')
    expect(container!.textContent).not.toContain('nothing connected reports')
    restore()
  })

  // Distinct dates, not a raw event count: two events landing on one day (e.g. illness logged
  // from two different chart clicks) are one flagged day to a reader scanning this card, not two.
  it('counts distinct flagged days, not raw events, when the period has some', async () => {
    const restore = stubFetchWithEvents([
      { id: 'e1', kind: 'illness', startedAtMs: 0, startedAtOffsetMinutes: 0, endedAtMs: null,
        endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-05' },
      { id: 'e2', kind: 'travel', startedAtMs: 0, startedAtOffsetMinutes: 0, endedAtMs: null,
        endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-05' },
      { id: 'e3', kind: 'caffeine', startedAtMs: 0, startedAtOffsetMinutes: 0, endedAtMs: null,
        endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-12' },
    ])
    const { client, tree } = withQuery(<FlaggedDaysCard range={RANGE} span={4} />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Flagged days')
    expect(card?.querySelector('.value')?.textContent).toBe('2')
    expect(card?.querySelector('.basis')?.textContent).toBe('2 days flagged in this period')
    restore()
  })
})

describe('mounted on Notes', () => {
  // The point of this task: Notes now mounts the same card Dashboard has always drawn, above its
  // own list, reading the same range-keyed useAnnotations() call NotesList already issues, so this
  // card costs the page no extra request.
  it('shows a card labelled Flagged days above the notes list', async () => {
    window.history.replaceState(null, '', '/notes?range=month&on=2026-08-15')
    const restore = stubFetchWithEvents([
      { id: 'e1', kind: 'illness', startedAtMs: 0, startedAtOffsetMinutes: 0, endedAtMs: null,
        endedAtOffsetMinutes: null, value: null, note: null, localDate: '2026-08-05' },
    ])
    const { client, tree } = withQuery(<Notes />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Flagged days')
    expect(card).toBeDefined()
    expect(card?.querySelector('.value')?.textContent).toBe('1')
    restore()
  })
})
