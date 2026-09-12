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
import { flush } from './flush.js'

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
