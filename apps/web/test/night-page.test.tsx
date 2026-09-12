// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import type { Session } from '../src/auth/session.js'
import type { Night } from '../src/data/useNights.js'
import { NightDetail } from '../src/pages/NightDetail.js'
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/sleep/night/2026-08-03')
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

export const NIGHT: Night = {
  localDate: '2026-08-03', sourceId: 'watch', sessionIds: ['s1'],
  // 23:15 to 07:02 local (offset +120), the span the spec names: a night is not a local date.
  startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 3, 5, 2),
  startOffsetMinutes: 120, endOffsetMinutes: 120,
  naps: [], segments: [], excludedSessions: [],
}

/**
 * `nights` answers the /sleep/nights route; `series` answers every metric with one point;
 * `sources` answers /sources, the enumeration resolveSource checks a URL source against
 * (controls/source.ts's own comment on why an id absent from it is not yet a real choice).
 * Empty by default: most cases here never put a source on the URL at all.
 */
function stub(
  nights: Night[],
  series: Record<string, number | null> = {},
  sources: Array<{ id: string, name: string }> = [],
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sleep/nights')) return json({ items: nights, cursor: null })
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const body: Record<string, unknown> = {}
      for (const metric of params.getAll('metric')) {
        const value = series[metric]
        body[metric] = {
          points: value === undefined ? [] : [{ localDate: '2026-08-03', value, coverage: 1, source: 'watch' }],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sources')) {
      return json({
        items: sources.map((s) => ({
          id: s.id, externalId: s.id, displayName: s.name, alias: null, name: s.name,
          kind: 'device', createdAtMs: 0,
        })),
      })
    }
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

describe('the night page', () => {
  it('mounts cold at its own URL, with nothing in the query cache', async () => {
    // The deep link case: every other route into this page warms the cache first.
    const restore = stub([NIGHT])
    try {
      const { client, html } = mount(<NightDetail />)
      await flush(client, html)
      // formatSessionDateHeading carries no year (weekday, day, month only) - the same heading
      // SessionList and NightRow already render - so this names the cell rather than a substring
      // that happened to include a year nothing here ever prints.
      expect(container?.querySelector('.night-title')?.textContent).toBe('Monday, August 3')
    } finally { restore() }
  })

  it('names the night\'s own bedtime and wake, not the boundaries of its local date', async () => {
    const restore = stub([NIGHT])
    try {
      const { client, html } = mount(<NightDetail />)
      await flush(client, html)
      expect(container?.querySelector('.night-when')?.textContent).toBe('23:15 to 07:02 · watch')
    } finally { restore() }
  })

  it('says so when the date names no night at all', async () => {
    const restore = stub([])
    try {
      const { client, html } = mount(<NightDetail />)
      await flush(client, html)
      expect(html()).toContain('No night recorded')
    } finally { restore() }
  })

  it('draws the source the reader named rather than the longest recording', async () => {
    window.history.replaceState(null, '', '/sleep/night/2026-08-03?source=phone')
    const phone: Night = { ...NIGHT, sourceId: 'phone', endMs: NIGHT.startMs + 3_600_000 }
    // 'phone' has to be a source this person actually has for resolveSource to honour it
    // (controls/source.ts) - an empty /sources here would make 'phone' unrecognised and fall
    // back to the all-sources view, silently recreating the exact bug decision #1 forbids rather
    // than testing that a real named source is drawn.
    const restore = stub([NIGHT, phone], {}, [{ id: 'phone', name: 'phone' }])
    try {
      const { client, html } = mount(<NightDetail />)
      await flush(client, html)
      expect(container?.querySelector('.night-when')?.textContent).toBe('23:15 to 00:15 · phone')
    } finally { restore() }
  })
})
