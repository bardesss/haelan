// @vitest-environment happy-dom
//
// happy-dom, not the default node environment: NightTraces mounts IntradayHeartRate, whose own
// useChart effect calls echarts.init, the same reason workout-trace-card.test.tsx (the file this
// one is modelled on) gives for its own file. echarts.init itself is mocked below so this file
// never touches a real canvas.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import type { Session } from '../src/auth/session.js'
import type { Night } from '../src/data/useNights.js'
import { NightTraces, NIGHT_TRACE_METRICS } from '../src/pages/sleep/NightTraces.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { flush, pumpUntil } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason workout-trace-card.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

/**
 * Stands in for the real echarts instance, the same stub workout-trace-card.test.tsx uses, so a
 * card that actually has points to draw does not reach a real canvas.
 */
function chartStub() {
  return { on: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }
}

vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, init: () => chartStub() }
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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

const NIGHT: Night = {
  localDate: '2026-08-03', sourceId: 'watch', sessionIds: ['s1'],
  startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 3, 5, 2),
  startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], segments: [], excludedSessions: [],
}

const point = (sourceId: string) => ({
  sourceId, utcMs: Date.UTC(2026, 7, 2, 23, 0), min: 48, mean: 52, max: 58, n: 1, excluded: false,
})

/** Keyed by `<metric>|<source>`, where an absent `source` parameter is the empty string. */
function stub(answers: Record<string, unknown[]>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/intraday/window')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const key = `${params.get('metric') ?? ''}|${params.get('source') ?? ''}`
      return json({ points: answers[key] ?? [], reduction: null })
    }
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

describe('the overnight traces', () => {
  it('asks for each metric across the night\'s own window, not its local date', async () => {
    const restore = stub({ 'heart_rate|watch': [point('watch')] })
    try {
      const { client, html } = mount(<NightTraces night={NIGHT} chosenSource={null} />)
      await flush(client, html)
      const hr = requested.find((url) => url.includes('metric=heart_rate'))
      expect(hr).toContain(`startMs=${NIGHT.startMs}`)
      expect(hr).toContain(`endMs=${NIGHT.endMs}`)
    } finally { restore() }
  })

  it('renders a card only for the metrics something actually recorded', async () => {
    const restore = stub({ 'heart_rate|watch': [point('watch')] })
    try {
      const { client, html } = mount(<NightTraces night={NIGHT} chosenSource={null} />)
      await flush(client, html)
      // spo2 and hrv both pin to `watch`, find nothing, and need a second, unpinned request
      // before either can render as absent (useSourceTrace's own fallback rule) - three concurrent
      // NightTrace instances means up to three such second-stage requests in flight together, each
      // resolving through react-query's own setTimeout(0)-scheduled notification
      // (notifyManager's default scheduler). Windows' coarse timer granularity (this repo's own
      // measured ~10-14ms per setTimeout, see the flush()/pumpUntil budget comments) can land that
      // notification a poll or two after flush() already reads "nothing in flight", so a second
      // wait on the actual condition - not flush()'s own "stopped changing" heuristic - is what
      // this assertion needs to be reliable here.
      await pumpUntil(
        () => (container?.querySelectorAll('.night-trace').length ?? -1) <= 1,
        'the metrics with nothing recorded to finish falling back and disappear',
      )
      expect(container?.querySelectorAll('.night-trace')).toHaveLength(1)
    } finally { restore() }
  })

  it('falls back to every other source when the night\'s own device recorded nothing, and says so', async () => {
    // The same 5-in-198 case the workout page's rule was measured against: a night assembled per
    // (localDate, sourceId) can be as silent as a watch that recorded no heart rate.
    const restore = stub({ 'heart_rate|watch': [], 'heart_rate|': [point('phone')] })
    try {
      const { client, html } = mount(<NightTraces night={NIGHT} chosenSource={null} />)
      await flush(client, html)
      // No source names are stubbed, so nameOf('watch') falls back to the raw id itself
      // (useSourceNames.ts's own fallback rule) - this is the sentence a reader with no alias set
      // for `watch` actually sees. The metric is named in words ("heart rate"), not by its raw
      // catalogue id: this is the exact defect a review found in an earlier version of this card -
      // toContain('recorded no') passed identically whether the sentence said "heart rate" or
      // "heart_rate", so it could not catch a wording regression, only presence. Asserting the
      // full sentence, the same idiom workout-trace-card.test.tsx's own ".basis" assertion uses,
      // is what actually pins the wording.
      const expected = 'watch recorded no heart rate for this night, so this is every other device '
        + 'instead; this 1 point is the reading'
      // All three metrics need the second, unpinned request here, which is exactly the shape the
      // previous test's own comment on Windows timer granularity describes - flush() can settle a
      // poll early on the cached "nothing in flight" state while the component's own re-render is
      // still queued behind it.
      //
      // The wait is for the line to EXIST, not for it to already say the sentence: waiting on the
      // sentence and then asserting the same sentence is a condition that can only ever time out,
      // never fail, and a timeout says "the fallback basis line to render" whatever the line
      // actually said. Existence and wording are two different claims, and the card carries no
      // basis at all until the fallback has answered - there is no state where this returns on a
      // line that is still going to change.
      await pumpUntil(
        () => container?.querySelector('.basis') !== null,
        'the fallback basis line to render',
      )
      expect(container?.querySelector('.basis')?.textContent).toBe(expected)
    } finally { restore() }
  })

  // NightTraces.tsx's own comment on NIGHT_TRACE_METRICS admits the metric list is written out
  // twice - the exported constant and the three literal <NightTrace> calls - with nothing at the
  // type level holding the two copies in step. This is what actually catches that drift: adding a
  // fourth metric to one without the other would either leave a card this test never sees drawn
  // (NIGHT_TRACE_METRICS grew but the JSX did not) or fail count-mismatched the other way around.
  it('renders one card per metric in NIGHT_TRACE_METRICS when every one of them recorded something', async () => {
    const restore = stub({
      'heart_rate|watch': [point('watch')], 'spo2|watch': [point('watch')], 'hrv|watch': [point('watch')],
    })
    try {
      const { client, html } = mount(<NightTraces night={NIGHT} chosenSource={null} />)
      await flush(client, html)
      expect(container?.querySelectorAll('.night-trace')).toHaveLength(NIGHT_TRACE_METRICS.length)
    } finally { restore() }
  })

  it('never falls back from a source the reader named', async () => {
    const restore = stub({ 'heart_rate|phone': [], 'heart_rate|': [point('watch')] })
    try {
      const { client, html } = mount(<NightTraces night={NIGHT} chosenSource="phone" />)
      await flush(client, html)
      expect(container?.querySelectorAll('.night-trace')).toHaveLength(0)
      expect(requested.some((url) => url.includes('metric=heart_rate') && !url.includes('source='))).toBe(false)
    } finally { restore() }
  })
})
