// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { sessionTarget } from '@haelan/core/target-key'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { Night } from '../src/data/useNights.js'
import { NightSessions } from '../src/pages/sleep/NightSessions.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

// sessionIds and excludedSessions disjoint, the shape readSleepNights actually sends
// (packages/core/src/query/sleepNights.ts assembles the kept night from one set of rows and
// separately collects the ones a correction dropped into the other): the two lists can never
// share an id, so a fixture that put 's2' in both, the way this file used to, is one no server can
// send. Two kept sessions rather than one is deliberate too - it is what gives the panel-scope
// test below two real clickable rows to tell apart, so a regression to a hardcoded
// `sessionIds[0]` has something to fail against.
const NIGHT: Night = {
  localDate: '2026-08-03', sourceId: 'watch', sessionIds: ['s1', 's2'],
  startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 3, 5, 2),
  startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], segments: [], excludedSessions: ['s3'],
}

// The native setter, not the tracked React one: assigning .value directly goes through React's
// own tracked setter and leaves onChange never firing, pass or fail, no matter what the handler
// does (annotate-panel.test.tsx's own copy of this helper explains the mechanism at more length).
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

function mount(night: Night): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><NightSessions night={night} /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

describe('the night\'s sessions', () => {
  // The bug this whole file was rewritten for: night.excludedSessions and night.sessionIds are
  // disjoint by construction (readSleepNights never puts the same id in both), so a card that only
  // ever iterated night.sessionIds could not render an excluded session at all - the id was simply
  // never in the list it looped over. A count of `.night-session` across BOTH lists is what an
  // implementation regressing to "iterate night.sessionIds only" fails, since it would render 2
  // rather than 3.
  it('renders a row for every session the night carries, kept or excluded alike', () => {
    mount(NIGHT)
    expect(container?.querySelectorAll('.night-session')).toHaveLength(3)
  })

  it('offers one control per session the night was assembled from', () => {
    mount(NIGHT)
    // Only the kept sessions (night.sessionIds) carry a control; the excluded one carries a status
    // word instead (the next test covers that), so this counts controls specifically rather than
    // rows, which the test above already does.
    expect(container?.querySelectorAll('.night-session button')).toHaveLength(2)
  })

  it('marks the session that is already excluded, rather than offering to exclude it again', () => {
    mount(NIGHT)
    const rows = [...(container?.querySelectorAll('.night-session') ?? [])]
    const excluded = rows.filter((row) => row.textContent?.includes('Excluded'))
    expect(excluded).toHaveLength(1)
    // The stronger half of the claim: the excluded row itself carries no button, so there is no
    // way to click "exclude" on a session that is already excluded. An implementation that shows
    // the "Excluded" label ALONGSIDE the exclude button (rather than instead of it) would still
    // pass the count assertion above; this is the one that catches it.
    expect(excluded[0]?.querySelector('button')).toBeNull()
  })

  it('opens the annotate panel at session scope for the session whose own control was clicked, not always the first row', async () => {
    let posted: Record<string, unknown> | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      posted = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      return respond(200, { id: 'o1', affected: null, applied: true })
    }) as typeof fetch

    try {
      mount(NIGHT)
      const buttons = [...(container?.querySelectorAll('.night-session button') ?? [])] as HTMLButtonElement[]
      expect(buttons).toHaveLength(2)
      // The SECOND control, not the first: a component that opened `sessionIds[0]`'s panel
      // regardless of which button was actually clicked would still show a dialog offering Exclude
      // and not Correct, so the two assertions below alone cannot catch that regression. Only the
      // POST body's own targetKey, asserted further down, names which session this write actually
      // targeted.
      act(() => { buttons[1]?.click() })
      const dialog = container?.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      // Exclude and note only: correct is sample scope, and an event belongs to a day.
      expect(dialog?.textContent).toContain('Exclude')
      expect(dialog?.textContent).not.toContain('Correct')

      const reason = container?.querySelector('.annotate-panel input.input') as HTMLInputElement
      type(reason, 'strap fell off')
      const submit = container?.querySelector('button[type="submit"]') as HTMLButtonElement
      act(() => { submit.click() })
      await settle()

      expect(posted).not.toBeNull()
      // Built with sessionTarget itself, not a hand written literal, and named 's2' - the id of the
      // SECOND button clicked above, not night.sessionIds[0] ('s1').
      expect(posted!['targetKey']).toBe(sessionTarget('s2'))
    } finally { globalThis.fetch = original }
  })
})
