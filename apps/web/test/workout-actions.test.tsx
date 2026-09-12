// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { sessionTarget } from '@haelan/core/target-key'
import { AnnotatePanel } from '../src/components/AnnotatePanel.js'
import { useWriteOverride } from '../src/data/useAnnotations.js'
import type { Session } from '../src/auth/session.js'
import { flush } from './flush.js'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

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

describe('the annotate panel at session scope', () => {
  // Rendered without an I18nProvider, following chart-marks.test.tsx's own convention: with a
  // provider t() returns translated copy, so asserting on a key here would really be asserting on
  // English prose. The catalogue path is annotate.actions.* (plural) — annotate.action.* (singular)
  // is not a real key and would never appear in the markup either way. A bare QueryClientProvider
  // is still required: AnnotatePanel calls useWriteOverride/useWriteNote/useWriteEvent
  // unconditionally, and each calls useSession, which throws without a QueryClient in context
  // regardless of which i18n path is under test.
  it('offers exclude and note, and never correct or event', () => {
    // correct is sample scope only (OverrideStore.validate enforces it), and an event belongs to a
    // day rather than to one workout.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AnnotatePanel target={{ scope: 'session', localDate: '2026-08-03', sessionId: 'run1' }}
          onClose={() => {}} />
      </QueryClientProvider>,
    )
    expect(html).toContain('annotate.actions.exclude')
    expect(html).toContain('annotate.actions.note')
    expect(html).not.toContain('annotate.actions.correct')
    expect(html).not.toContain('annotate.actions.event')
  })

  it('builds the target key with sessionTarget and no key a reader could type', () => {
    // The same encoder the store and the route read back with, so the panel never types a key.
    expect(sessionTarget('run1')).toBe(JSON.stringify({ session: 'run1' }))
  })
})

describe('a session-scope write', () => {
  it('invalidates the cached session and the cached window, which no range key can match', async () => {
    // overlapsAffected finds a cached query by reading a string from/to out of its key params.
    // useWorkoutSession keys on { sessionId } and useIntradayWindow on millisecond bounds, so
    // neither can EVER match, and both would sit stale for up to their staleTime while the
    // range-keyed activity list struck the session through immediately — two surfaces disagreeing
    // about a correction the reader just made.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    const sessionKey = queryKeys.resource('p1', 'session', { sessionId: 'run1' })
    const windowKey = queryKeys.resource('p1', 'intraday-window', {
      metric: 'heart_rate', startMs: 1, endMs: 2, source: 'watch',
    })
    client.setQueryData(sessionKey, { id: 'run1', excluded: false })
    client.setQueryData(windowKey, { points: [], reduction: null })

    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ id: 'o1', affected: null, applied: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

    try {
      let write: ReturnType<typeof useWriteOverride> | null = null
      function Probe() { write = useWriteOverride(); return null }
      act(() => {
        root?.render(
          <QueryClientProvider client={client}>
            <I18nProvider lng="en"><Probe /></I18nProvider>
          </QueryClientProvider>,
        )
      })
      act(() => {
        write!.mutate({ scope: 'session', targetKey: sessionTarget('run1'), action: 'exclude', reason: 'strap' })
      })
      await flush(client, () => container?.innerHTML ?? '')

      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true)
      expect(client.getQueryState(windowKey)?.isInvalidated).toBe(true)
    } finally { globalThis.fetch = original }
  })
})
