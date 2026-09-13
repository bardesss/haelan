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
import { pumpUntil } from './flush.js'

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

const NIGHT: Night = {
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

/**
 * Waits for the page to have left its loading state, then for nothing to be left in flight.
 *
 * The same two conditions workout-page.test.tsx waits on, for the same reason and against the same
 * defect: `NightDetail` reaches its data through a query gated on `personId`, which arrives from
 * `useSession`'s own request, and `flush()` reads the window between the two as a settled page -
 * nothing in flight, and the same "Loading" on screen either side of it. CI caught this file on
 * Node 24 with `expected undefined to be 'Monday, August 3'`, which is that window: the title
 * element the assertion reaches for does not exist yet, because the page never loaded.
 *
 * `flush()` cannot be layered underneath these: its guard needs the fetch count to leave zero
 * while it is watching, and by the time the page has left its loading state everything has already
 * resolved, so it throws "never started". See flush.test.tsx's KNOWN GAP case for the mechanism.
 */
async function settled(client: QueryClient, html: () => string): Promise<void> {
  await pumpUntil(() => !html().includes('>Loading<'), 'the night page to leave its loading state')
  await pumpUntil(
    () => client.isFetching() + client.isMutating() === 0,
    'the page to have nothing left in flight',
  )
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
      await settled(client, html)
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
      await settled(client, html)
      expect(container?.querySelector('.night-when')?.textContent).toBe('23:15 to 07:02 · watch')
    } finally { restore() }
  })

  it('says so when the date names no night at all', async () => {
    const restore = stub([])
    try {
      const { client, html } = mount(<NightDetail />)
      await settled(client, html)
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
      await settled(client, html)
      expect(container?.querySelector('.night-when')?.textContent).toBe('23:15 to 00:15 · phone')
    } finally { restore() }
  })
})

describe('the night tiles', () => {
  it('reads each figure from the metric the derivation already owns', async () => {
    const restore = stub([NIGHT], {
      sleep_asleep_minutes: 447, sleep_in_bed_minutes: 467, sleep_efficiency: 96,
      sleep_deep_minutes: 62, sleep_light_minutes: 290, sleep_rem_minutes: 95,
      sleep_awake_minutes: 20, sleep_nap_count: 1,
    })
    try {
      const { client, html } = mount(<NightDetail />)
      await settled(client, html)
      const tiles = [...(container?.querySelectorAll('.night-tiles .card') ?? [])]
      const valueOf = (label: string) => tiles
        .find((tile) => tile.querySelector('.label')?.textContent === label)
        ?.querySelector('.value')?.textContent
      expect(valueOf('Time asleep')).toBe('7h 27m')
      expect(valueOf('Time in bed')).toBe('7h 47m')
      // Unit-carrying, not the bare number: StatTile's own unit prop puts a space before it
      // ("96 %"), the same rendering Sleep.tsx's own efficiency tile already uses for this exact
      // metric - the two surfaces used to disagree about what the headline number even was.
      expect(valueOf('Efficiency')).toBe('96 %')
      expect(valueOf('Deep')).toBe('1h 02m')
      expect(valueOf('Time awake')).toBe('0h 20m')
      expect(valueOf('Naps')).toBe('1')
    } finally { restore() }
  })

  it('omits a tile for a metric this night has no row for', async () => {
    const restore = stub([NIGHT], { sleep_asleep_minutes: 447 })
    try {
      const { client, html } = mount(<NightDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.night-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toEqual(['Time asleep'])
    } finally { restore() }
  })

  it('does not clamp an efficiency above 100, because clamping would hide a real defect', async () => {
    // Overlapping sleep sessions can push sleep_efficiency over 100. That is a derivation defect,
    // pinned as the KNOWN GAP tests in packages/core/test/sleep-derive.test.ts ("KNOWN GAP:
    // overlapping sessions within a night double count toward asleep and efficiency"), and this
    // page makes it more visible than the Sleep page does. Showing 104 is the point: a plausible
    // 100 would hide it.
    const restore = stub([NIGHT], { sleep_efficiency: 104 })
    try {
      const { client, html } = mount(<NightDetail />)
      await settled(client, html)
      const tiles = [...(container?.querySelectorAll('.night-tiles .card') ?? [])]
      const efficiency = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Efficiency')
      // '104 %', not '104': the unit carries through the switch to formatMetricValue exactly the
      // same as the non-clamped figure does, since neither is a change formatMetricValue makes.
      expect(efficiency?.querySelector('.value')?.textContent).toBe('104 %')
    } finally { restore() }
  })

  it('says the request failed, not that this night has no sleep at all, when the tiles\' own series request errors', async () => {
    // A failed /series is not the same statement as a night with no time asleep, no deep sleep and
    // no efficiency - the exact false-by-omission claim NightTraces.tsx and NightStages.tsx each
    // already argue against in their own comments, applying identically here: groups.pointsOf
    // reads an errored query's undefined data the same way it reads an empty one, so without an
    // explicit isError gate every tile would just vanish rather than say what actually happened.
    const restore = (() => {
      const original = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
        if (url.includes('/api/auth/me')) return json(PERSON)
        if (url.includes('/sleep/nights')) return json({ items: [NIGHT], cursor: null })
        if (url.includes('/series')) {
          return new Response(JSON.stringify({ error: { code: 'internal' } }),
            { status: 500, headers: { 'content-type': 'application/json' } })
        }
        if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
        if (url.includes('/sources')) return json({ items: [] })
        return json({})
      }) as typeof fetch
      return () => { globalThis.fetch = original }
    })()
    try {
      const { client, html } = mount(<NightDetail />)
      await settled(client, html)
      expect(container?.querySelectorAll('.night-tiles')).toHaveLength(0)
      expect(html()).toContain('This did not load.')
      expect(html()).not.toContain('Nothing has been recorded for this period.')
    } finally { restore() }
  })
})
