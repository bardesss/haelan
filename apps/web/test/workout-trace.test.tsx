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
import { useWorkoutTrace } from '../src/data/useWorkoutTrace.js'
import { flush, pumpUntil } from './flush.js'

// The rule this file exists for, from the design: 189 of 198 measured sessions are answered by the
// recording device, 2 by either, and 5 ONLY by another device — where pinning draws an empty chart
// that reads as "no heart rate recorded", which is false. And an explicit choice never falls back,
// because empty is the honest answer to a specific question.

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

const point = (sourceId: string) => ({
  sourceId, utcMs: Date.UTC(2026, 7, 3, 6, 10), min: 120, mean: 130, max: 140, n: 1, excluded: false,
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let requested: string[] = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  requested = []
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

/** `answers` decides, per `source` query parameter value ('' for a request that sent none), what
 *  the window route returns. That is exactly the distinction the rule turns on. */
function stub(answers: Record<string, unknown[]>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/intraday/window')) {
      const source = new URLSearchParams(url.split('?')[1] ?? '').get('source') ?? ''
      return json({ points: answers[source] ?? [], reduction: null })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function Probe({ chosenSource, seen }: { chosenSource: string | null, seen: { current: unknown } }) {
  const trace = useWorkoutTrace({
    metric: 'heart_rate',
    startMs: Date.UTC(2026, 7, 3, 6, 0), endMs: Date.UTC(2026, 7, 3, 6, 54),
    sessionSourceId: 'watch', chosenSource,
  })
  seen.current = trace
  return <span>{trace.points.length}</span>
}

function mount(node: ReactNode): { client: QueryClient, html: () => string } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">{node}</I18nProvider>
      </QueryClientProvider>,
    )
  })
  return { client, html: () => container?.innerHTML ?? '' }
}

describe('which source a workout trace asks for', () => {
  it('pins to the device that recorded the workout', async () => {
    const restore = stub({ watch: [point('watch')] })
    try {
      const seen = { current: null as never }
      const { client, html } = mount(<Probe chosenSource={null} seen={seen} />)
      await flush(client, html)
      expect((seen.current as { traceSource: string }).traceSource).toBe('pinnedSource')
      expect(requested.filter((url) => url.includes('/intraday/window'))).toHaveLength(1)
    } finally { restore() }
  })

  it('asks again unpinned when the recording device logged nothing, and says so', async () => {
    // The 5-in-198 case. Without this an empty chart would read as "no heart rate recorded".
    const restore = stub({ watch: [], '': [point('phone')] })
    try {
      const seen = { current: null as never }
      const { client, html } = mount(<Probe chosenSource={null} seen={seen} />)
      await flush(client, html)
      const trace = seen.current as { traceSource: string, points: unknown[] }
      expect(trace.traceSource).toBe('otherSources')
      expect(trace.points).toHaveLength(1)
    } finally { restore() }
  })

  it('stays empty and pinned when nobody recorded anything', async () => {
    const restore = stub({ watch: [], '': [] })
    try {
      const seen = { current: null as never }
      const { client, html } = mount(<Probe chosenSource={null} seen={seen} />)
      await flush(client, html)
      const trace = seen.current as { traceSource: string, points: unknown[] }
      expect(trace.traceSource).toBe('pinnedSource')
      expect(trace.points).toHaveLength(0)
    } finally { restore() }
  })

  it('never falls back from a source the reader chose', async () => {
    // Empty is the honest answer to a specific question; silently answering a different one is the
    // failure the whole rule exists to prevent.
    const restore = stub({ phone: [], '': [point('watch')] })
    try {
      const seen = { current: null as never }
      const { client, html } = mount(<Probe chosenSource="phone" seen={seen} />)
      await flush(client, html)
      const trace = seen.current as { traceSource: string, points: unknown[] }
      expect(trace.points).toHaveLength(0)
      expect(trace.traceSource).toBe('pinnedSource')
      expect(requested.some((url) => url.includes('/intraday/window') && !url.includes('source='))).toBe(false)
    } finally { restore() }
  })
})

describe('retrying after the fallback itself failed', () => {
  // Task 4 review finding: `if (fellBack) void blended.refetch()` only re-asks the blended query
  // once it has already succeeded. The reachable state this misses is the reader having chosen
  // nothing, the pin answering empty, and the blended read then ERRORING (not merely "not
  // succeeded yet") - `fellBack` is false in that state, exactly as it should be, but a Retry click
  // still has to re-ask the query that actually failed, or the card is stuck: TanStack does not
  // retry a disabled-then-enabled query's error on its own (enabled never transitions false→true
  // here), and re-asking only `pinned` re-fetches a query that already gave its own honest empty
  // answer and has nothing left to say differently.
  it('refetches the blended query on retry after it errors, not only after it answers', async () => {
    let blendedCalls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/intraday/window')) {
        const source = new URLSearchParams(url.split('?')[1] ?? '').get('source') ?? ''
        if (source === 'watch') return json({ points: [], reduction: null })
        // The blended (no source) request: fails the first time, succeeds once retried.
        blendedCalls += 1
        if (blendedCalls === 1) return new Response('boom', { status: 500 })
        return json({ points: [point('phone')], reduction: null })
      }
      return json({})
    }) as typeof fetch
    try {
      const seen = { current: null as never }
      const { client, html } = mount(<Probe chosenSource={null} seen={seen} />)
      await flush(client, html)
      expect((seen.current as { isError: boolean }).isError).toBe(true)
      expect(blendedCalls).toBe(1)

      act(() => { (seen.current as { refetch: () => unknown }).refetch() })
      await flush(client, html)

      expect(blendedCalls).toBe(2)
      const trace = seen.current as { traceSource: string, points: unknown[], isError: boolean }
      expect(trace.isError).toBe(false)
      expect(trace.traceSource).toBe('otherSources')
      expect(trace.points).toHaveLength(1)
    } finally { globalThis.fetch = original }
  })
})

describe('pending while the fallback is still in flight', () => {
  // flush() cannot observe this state: it waits for nothing to be in flight, and the whole point
  // here is a request that stays in flight throughout. pumpUntil() (apps/web/test/flush.ts) is
  // built for exactly this and is already used elsewhere in the suite (dashboard-cards.test.tsx's
  // own "does not claim there is no baseline while the baseline request is in flight").
  it('stays pending rather than settling on the empty pinned answer while the blended request hangs', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/intraday/window')) {
        const source = new URLSearchParams(url.split('?')[1] ?? '').get('source') ?? ''
        if (source === 'watch') return json({ points: [], reduction: null })
        // The blended request: deliberately left hanging, so the fallback never settles.
        return new Promise<Response>(() => {})
      }
      return json({})
    }) as typeof fetch
    try {
      const seen = { current: null as never }
      mount(<Probe chosenSource={null} seen={seen} />)
      await pumpUntil(
        () => requested.filter((url) => url.includes('/intraday/window')).length === 2,
        'the blended request to start',
      )
      const trace = seen.current as { isPending: boolean, points: unknown[], traceSource: string }
      // Not the empty pinned answer rendered early and about to be replaced: the hook's own
      // comment on `isPending` is exactly the claim this test pins - a card that called itself
      // settled here would show "no heart rate recorded", which is false while the fallback is
      // still asking.
      expect(trace.isPending).toBe(true)
      expect(trace.points).toHaveLength(0)
    } finally { globalThis.fetch = original }
  })
})
