// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Notes } from '../src/pages/Notes.js'
import type { StoredEvent, StoredNote } from '../src/data/useAnnotations.js'
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
// Set by mount, cleared by afterEach unconditionally, the same discipline
// override-list.test.tsx's own restoreFetch holds: a test that asserts before restoring its own
// stub (or throws out of an assertion) would otherwise leave globalThis.fetch patched for every
// test still to run in this file, turning one red test into a cascade of unrelated ones.
let restoreFetch: (() => void) | null = null
// Every request mount's own stub answers, method included. This is the thing "removes an event
// through the mutation" actually pins: a row leaving local state proves nothing on its own, since
// a row that vanished from state with no request behind it looks identical on screen.
let sent: { url: string, method: string }[] = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sent = []
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  if (restoreFetch) {
    restoreFetch()
    restoreFetch = null
  }
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function html(): string {
  return container!.innerHTML
}

function rows(): HTMLTableRowElement[] {
  return [...container!.querySelectorAll('tbody tr')] as HTMLTableRowElement[]
}

function cells(row: HTMLTableRowElement): string[] {
  return [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
}

/**
 * Answers every request Notes.tsx and the ControlRow it renders can issue: notes and events off
 * mutable lists, so a DELETE actually shrinks what the next GET answers rather than the stub
 * lying about what a real removal does underneath it (stubFetch in override-list.test.tsx holds
 * the same discipline for overrides); an always-empty overrides list, since useAnnotations fetches
 * it unconditionally and this page has no use for it; and a quiet sync status, since ControlRow
 * reads one on every mount regardless of what this file is testing. `removeStatus` lets a test
 * drive a DELETE that fails, the same way stubFetch's own `removalApplied` flag does for overrides.
 */
function mockFetch(initialNotes: readonly StoredNote[], initialEvents: readonly StoredEvent[], removeStatus = 200): void {
  const noteItems = [...initialNotes]
  let eventItems = [...initialEvents]
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    sent.push({ url, method })
    if (url.includes('/api/sync/status')) return respond(200, { running: false, lastFinishedAtMs: null })
    if (method === 'DELETE' && url.includes('/events/')) {
      if (removeStatus !== 200) return respond(removeStatus, { error: { message: 'boom' } })
      const id = url.split('/events/')[1]
      eventItems = eventItems.filter((item) => item.id !== id)
      return respond(200, { id })
    }
    if (url.includes('/notes')) return respond(200, { items: noteItems })
    if (url.includes('/events')) return respond(200, { items: eventItems })
    if (url.includes('/overrides')) return respond(200, { items: [] })
    return respond(404, {})
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
}

/** Mounts Notes inside a real I18nProvider (English) and a QueryClientProvider carrying a signed
 * in session, the same shape override-list.test.tsx's own mount takes: a real fetch backed set of
 * queries and mutations only exists once the tree is mounted for real. Returns the QueryClient so
 * a test can wait on it with flush(). */
function mount(
  fixtures: { notes?: readonly StoredNote[], events?: readonly StoredEvent[] }, removeStatus = 200,
): QueryClient {
  mockFetch(fixtures.notes ?? [], fixtures.events ?? [], removeStatus)
  const c = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  c.setQueryData(queryKeys.session(), PERSON)
  act(() => { root?.render(<I18nProvider lng="en"><QueryClientProvider client={c}><Notes /></QueryClientProvider></I18nProvider>) })
  return c
}

function settle(c: QueryClient): Promise<void> {
  return flush(c, html)
}

const FEVER_EVENT: StoredEvent = {
  id: 'e1', kind: 'illness', note: 'Fever', localDate: '2026-08-16',
  startedAtMs: Date.parse('2026-08-16T09:00:00Z'), startedAtOffsetMinutes: 0,
  endedAtMs: null, endedAtOffsetMinutes: null, value: null,
}

const SLEPT_BADLY_NOTE: StoredNote = { id: 'n1', localDate: '2026-08-14', body: 'Slept badly', updatedAtMs: 0 }

describe('interleaving notes and events', () => {
  it('interleaves notes and events newest first', async () => {
    const c = mount({ notes: [SLEPT_BADLY_NOTE], events: [FEVER_EVENT] })
    await settle(c)

    const markup = html()
    expect(markup.indexOf('2026-08-16')).toBeLessThan(markup.indexOf('2026-08-14'))
  })

  it('shows a note\'s day and body, with no kind and no remove control', async () => {
    const c = mount({ notes: [SLEPT_BADLY_NOTE] })
    await settle(c)

    const row = rows()[0]!
    const [date, kind, text] = cells(row)
    expect(date).toBe('2026-08-14')
    expect(kind).toBe('')
    expect(text).toBe('Slept badly')
    expect(row.querySelector('button')).toBeNull()
  })

  it('shows an event\'s translated kind, its own note and its value', async () => {
    const c = mount({ events: [{ ...FEVER_EVENT, value: 38.5 }] })
    await settle(c)

    const row = rows()[0]!
    const [date, kind, text, value] = cells(row)
    expect(date).toBe('2026-08-16')
    expect(kind).toBe('Illness')
    expect(text).toBe('Fever')
    expect(value).toBe('38.5')
  })

  it('prints an event kind past the seed set exactly as typed, not translated', async () => {
    const c = mount({ events: [{ ...FEVER_EVENT, kind: 'root canal' }] })
    await settle(c)

    const row = rows()[0]!
    const [, kind] = cells(row)
    expect(kind).toBe('root canal')
  })
})

describe('removing an event', () => {
  it('removes an event through the mutation rather than only hiding the row', async () => {
    const c = mount({ events: [FEVER_EVENT] })
    await settle(c)
    expect(rows()).toHaveLength(1)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(c, html)

    expect(sent.map((r) => r.method)).toContain('DELETE')
    expect(rows()).toHaveLength(0)
  })

  it('leaves the row in place and says removal failed, rather than dropping it on a failed request', async () => {
    const c = mount({ events: [FEVER_EVENT] }, 500)
    await settle(c)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(c, html)

    expect(rows()).toHaveLength(1)
    expect(html()).toContain('That did not remove. Try again.')
  })
})

describe('the query states', () => {
  it('shows an empty state when there are no notes or events', async () => {
    const c = mount({})
    await settle(c)

    expect(html()).toContain('No notes or events yet')
    expect(container!.querySelector('table')).toBeNull()
  })

  it('shows a retry on a failed read', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/sync/status')) return respond(200, { running: false, lastFinishedAtMs: null })
      return respond(500, { error: { message: 'boom' } })
    }) as typeof fetch
    restoreFetch = () => { globalThis.fetch = original }

    const c = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    c.setQueryData(queryKeys.session(), PERSON)
    act(() => { root?.render(<I18nProvider lng="en"><QueryClientProvider client={c}><Notes /></QueryClientProvider></I18nProvider>) })
    await settle(c)

    expect(html()).toContain('This did not load.')
    expect(container!.querySelector('.card button')?.textContent).toBe('Try again')
  })
})
