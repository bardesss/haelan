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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, baseUrl: 'http://localhost:4235',
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
 * drive a DELETE that fails, the same way stubFetch's own `removalApplied` flag does for overrides,
 * and applies to both DELETE branches below, since no test in this file drives the two at once.
 */
function mockFetch(
  initialNotes: readonly StoredNote[], initialEvents: readonly StoredEvent[],
  removeStatus = 200, removeDelayMs = 0,
): void {
  let noteItems = [...initialNotes]
  let eventItems = [...initialEvents]
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    sent.push({ url, method })
    if (url.includes('/api/sync/status')) return respond(200, { running: false, lastFinishedAtMs: null })
    if (method === 'DELETE' && url.includes('/events/')) {
      // A real delay, not zero, is what gives the pending removing test below a window to observe:
      // this stub otherwise resolves inside one microtask, too fast for any poll to ever catch.
      if (removeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, removeDelayMs))
      if (removeStatus !== 200) return respond(removeStatus, { error: { message: 'boom' } })
      const id = url.split('/events/')[1]
      eventItems = eventItems.filter((item) => item.id !== id)
      return respond(200, { id })
    }
    if (method === 'DELETE' && url.includes('/notes/')) {
      // Checked ahead of the plain '/notes' read below, and on '/notes/' rather than '/notes': the
      // GET this page issues carries a query string ('/notes?from=...'), never a path segment, so
      // only a DELETE's own localDate suffix ever matches this branch.
      if (removeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, removeDelayMs))
      if (removeStatus !== 200) return respond(removeStatus, { error: { message: 'boom' } })
      const localDate = url.split('/notes/')[1]
      noteItems = noteItems.filter((item) => item.localDate !== localDate)
      return respond(200, { id: localDate })
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
  fixtures: { notes?: readonly StoredNote[], events?: readonly StoredEvent[] }, removeStatus = 200, removeDelayMs = 0,
): QueryClient {
  mockFetch(fixtures.notes ?? [], fixtures.events ?? [], removeStatus, removeDelayMs)
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

/**
 * flush.ts's own pumpUntil/flush can take longer to reach their documented timeout than vitest's
 * budget allows on this machine (confirmed separately, filed as its own follow-up, not this
 * file's to fix), which turns a genuinely unsatisfied wait into a generic vitest kill instead of
 * this poll's own message. Bounded low on purpose so the removal tests below stay inside budget
 * either way: the real DELETE this file drives resolves in a tick or two, and a broken one now
 * fails on the line below within about a second, not twenty.
 */
async function pollFor(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (ready()) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
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

  it('shows a note\'s day and body, with no kind, and a remove button of its own', async () => {
    const c = mount({ notes: [SLEPT_BADLY_NOTE] })
    await settle(c)

    const row = rows()[0]!
    const [date, kind, text] = cells(row)
    expect(date).toBe('2026-08-14')
    expect(kind).toBe('')
    expect(text).toBe('Slept badly')
    expect(row.querySelector('button')?.textContent).toBe('Remove')
  })

  it('gives a note\'s remove button an aria-label naming the day, with no kind in it', async () => {
    const c = mount({ notes: [SLEPT_BADLY_NOTE] })
    await settle(c)

    const button = rows()[0]!.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Remove note, 2026-08-14')
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

  it('names every column header, including the visually hidden remove column', async () => {
    const c = mount({ events: [FEVER_EVENT] })
    await settle(c)

    const headers = [...container!.querySelectorAll('thead th')] as HTMLTableCellElement[]
    expect(headers.map((h) => h.textContent)).toEqual(['Date', 'Kind', 'Text', 'Value', 'Remove'])
  })

  it('gives an event\'s remove button its own text and an aria-label naming the row', async () => {
    const c = mount({ events: [FEVER_EVENT] })
    await settle(c)

    const button = rows()[0]!.querySelector('button')!
    expect(button.textContent).toBe('Remove')
    expect(button.getAttribute('aria-label')).toBe('Remove Illness, 2026-08-16')
  })

  it('prints an event kind past the seed set exactly as typed, not translated', async () => {
    const c = mount({ events: [{ ...FEVER_EVENT, kind: 'root canal' }] })
    await settle(c)

    const row = rows()[0]!
    const [, kind] = cells(row)
    expect(kind).toBe('root canal')
  })

  // The comparator reads localDate alone, so two rows sharing a day are a tie (returns 0), and
  // Array#sort's own stability is what keeps the note ahead in that case, since noteRows is
  // spread first in rowsFrom.
  it('keeps a note ahead of an event on the same day', async () => {
    const sameDayNote: StoredNote = { id: 'n2', localDate: '2026-08-16', body: 'Rough one', updatedAtMs: 0 }
    const c = mount({ notes: [sameDayNote], events: [FEVER_EVENT] })
    await settle(c)

    const bodies = rows().map((row) => cells(row)[2])
    expect(bodies).toEqual(['Rough one', 'Fever'])
  })
})

describe('removing an event', () => {
  it('removes an event through the mutation rather than only hiding the row', async () => {
    const c = mount({ events: [FEVER_EVENT] })
    await settle(c)
    expect(rows()).toHaveLength(1)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // Not flush(): a second flush() call after everything has already settled cannot tell that
    // apart from a page that never started, and hangs (see pollFor's own comment). This asserts
    // the DELETE itself before waiting on its effect, so a click that only hides the row locally
    // fails here rather than on the row count below.
    await pollFor(() => sent.some((r) => r.method === 'DELETE'), 'the event DELETE request to go out')
    expect(sent.map((r) => r.method)).toContain('DELETE')
    await pollFor(() => rows().length === 0, 'the removed row to leave the table')

    expect(rows()).toHaveLength(0)
  })

  it('shows the removing label while the request is in flight, then removes the row', async () => {
    // A real delay on the DELETE response, or the pending state below has no window to be
    // observed at all: the stub otherwise resolves inside one microtask. 150ms rather than a
    // thinner margin, since pollFor samples at roughly 16ms of real cost on this machine and a
    // hosted CI runner is not guaranteed to be as fast.
    const c = mount({ events: [FEVER_EVENT] }, 200, 150)
    await settle(c)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await pollFor(() => rows()[0]?.querySelector('button')?.textContent === 'Removing', 'the pending removing label')
    expect(rows()[0]!.querySelector('button')!.disabled).toBe(true)
    await pollFor(() => rows().length === 0, 'the removed row to leave the table')
  })

  it('leaves the row in place and says removal failed, rather than dropping it on a failed request', async () => {
    const c = mount({ events: [FEVER_EVENT] }, 500)
    await settle(c)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await pollFor(() => sent.some((r) => r.method === 'DELETE'), 'the event DELETE request to go out')
    await pollFor(() => html().includes('That did not remove. Try again.'), 'the removal failed message to render')

    expect(rows()).toHaveLength(1)
    expect(html()).toContain('That did not remove. Try again.')
  })
})

describe('removing a note', () => {
  it('removes a note through the mutation rather than only hiding the row', async () => {
    const c = mount({ notes: [SLEPT_BADLY_NOTE] })
    await settle(c)
    expect(rows()).toHaveLength(1)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // Not flush(): see the comment on the same call in "removing an event" above. This asserts the
    // DELETE itself before waiting on its effect, so a click that only hides the row locally fails
    // here rather than on the row count below.
    await pollFor(() => sent.some((r) => r.method === 'DELETE'), 'the note DELETE request to go out')
    expect(sent.map((r) => r.method)).toContain('DELETE')
    await pollFor(() => rows().length === 0, 'the removed row to leave the table')

    expect(rows()).toHaveLength(0)
  })

  it('shows the removing label while the request is in flight, then removes the row', async () => {
    // A real delay, the same margin "removing an event" uses above, for the same reason: the
    // pending state below has no window to be observed at all against a stub that resolves inside
    // one microtask.
    const c = mount({ notes: [SLEPT_BADLY_NOTE] }, 200, 150)
    await settle(c)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await pollFor(() => rows()[0]?.querySelector('button')?.textContent === 'Removing', 'the pending removing label')
    expect(rows()[0]!.querySelector('button')!.disabled).toBe(true)
    await pollFor(() => rows().length === 0, 'the removed row to leave the table')
  })

  it('leaves the row in place and says removal failed, rather than dropping it on a failed request', async () => {
    const c = mount({ notes: [SLEPT_BADLY_NOTE] }, 500)
    await settle(c)

    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await pollFor(() => sent.some((r) => r.method === 'DELETE'), 'the note DELETE request to go out')
    await pollFor(() => html().includes('That did not remove. Try again.'), 'the removal failed message to render')

    expect(rows()).toHaveLength(1)
    expect(html()).toContain('That did not remove. Try again.')
  })

  // The isEvent guard on NotesList.tsx's own `removing` check, pinned directly: without it,
  // removeNote's pending `variables.localDate` would also match an event row sharing that date,
  // since nothing there tests which row is which. sameDayNote reuses FEVER_EVENT's own date, the
  // same collision "keeps a note ahead of an event on the same day" above sets up.
  it('does not mark a same day event as removing while a note delete is in flight', async () => {
    const sameDayNote: StoredNote = { id: 'n3', localDate: FEVER_EVENT.localDate, body: 'Rough one', updatedAtMs: 0 }
    const c = mount({ notes: [sameDayNote], events: [FEVER_EVENT] }, 200, 150)
    await settle(c)
    expect(rows()).toHaveLength(2)

    // rows()[0] is the note: the comparator ties on localDate and Array#sort's own stability
    // keeps noteRows, spread first in rowsFrom, ahead of the event.
    act(() => { rows()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await pollFor(() => rows()[0]?.querySelector('button')?.textContent === 'Removing', 'the pending note removing label')

    const eventButton = rows()[1]!.querySelector('button')!
    expect(eventButton.textContent).toBe('Remove')
    expect(eventButton.disabled).toBe(false)

    await pollFor(() => rows().length === 1, 'the removed note row to leave the table')
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
