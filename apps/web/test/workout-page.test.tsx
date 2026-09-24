// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import type { Session } from '../src/auth/session.js'
import type { RoutePoint, WorkoutSession } from '../src/data/useSessions.js'
import type { BanisterBasis } from '@haelan/core/cardio-load'
import type { FilledSplit } from '@haelan/core/split-heart-rate'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { pumpUntil } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason chart-lifecycle.test.tsx sets them. Only the source-resolution case below
// actually mounts a chart (every other case in this file keeps trace.points empty); harmless for
// the rest, which never touch echarts.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/activity/run1')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

export const RUN: WorkoutSession = {
  id: 'run1', sourceId: 'watch',
  startMs: Date.UTC(2026, 7, 3, 6, 0), endMs: Date.UTC(2026, 7, 3, 6, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: {
    exerciseType: 'RUNNING',
    displayName: 'Morning run',
    activeDuration: '3000s',
    exerciseMetadata: { hasGps: true },
    metricsSummary: { caloriesKcal: 412, distanceMillimeters: 8_000_000 },
  },
  excluded: false, excludeReason: null,
}

/** A session carrying nothing but its span: every optional card must be absent. */
const BARE: WorkoutSession = {
  ...RUN, id: 'bare', attrs: { exerciseType: 'WALKING' },
}

/** A Google session that says plainly there was nothing to record - the one case with no sentence
 *  at all, now that an absent exerciseMetadata means "unknown" rather than "false" (Task 7). */
const NO_GPS: WorkoutSession = {
  ...RUN, id: 'no-gps', attrs: { exerciseType: 'WALKING', exerciseMetadata: { hasGps: false } },
}

/** A companion session whose route Health Connect would not release: no points, and a flag saying
 *  a track exists and Health Connect answered ConsentRequired for it - route access not granted to
 *  Haelan, or granted per workout rather than always. The one case with no points that still has
 *  something true to say. */
const WITHHELD: WorkoutSession = {
  ...RUN, id: 'withheld', attrs: { exerciseType: 'RUNNING', routeConsentRequired: true },
}

/** A companion session: no exerciseMetadata at all, the same shape SyncEngine.kt sends today
 *  (task-3-report.md). Paired with a `route` below to cover both of its sentences: none when a
 *  route has points, the "could not read" one when it has none. */
const PHONE: WorkoutSession = {
  ...RUN, id: 'phone', sourceId: 'phone', attrs: { exerciseType: 'RUNNING' },
}

const ROUTE_POINT: RoutePoint = {
  atMs: Date.UTC(2026, 7, 3, 6, 10), latitude: 52.1, longitude: 4.3,
  altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
}

const BASIS: BanisterBasis = {
  restingBpm: 52, maxBpm: 181, maxBpmSource: 'providerZoneCeiling', k: 1.92, minutes: 45,
}

const SPLIT: FilledSplit = {
  startMs: null, endMs: null, splitType: 'DISTANCE', activeDurationSeconds: 300,
  distanceMeters: 1000, paceSecondsPerKm: 300, averageHeartRateBpm: 150,
  averageHeartRateBpmSource: 'provider',
}

function stub(sessions: Record<string, WorkoutSession>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    for (const [id, session] of Object.entries(sessions)) {
      if (url.includes(`/sessions/${id}`)) return json(session)
    }
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sessions')) return json({ items: [], cursor: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Answers the session request with an HTTP status rather than a session, everything else as
 * `stub` above. Used for the error and not-found branches: `stub` can only ever answer 200, since
 * every id absent from its `sessions` map falls through to the generic `/sessions` list route
 * (also matched by `.includes('/sessions')`) rather than 404ing the way a real miss on
 * `/sessions/:id` does.
 */
function stubSessionError(status: number): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown, responseStatus = 200) =>
      new Response(JSON.stringify(body), { status: responseStatus, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sessions/run1')) return json({}, status)
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sessions')) return json({ items: [], cursor: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Waits for the page to have left its loading state, then for everything else to settle.
 *
 * `flush()` alone is not enough here, and this file is where that cost a day. Every case below
 * mounts `WorkoutDetail` cold, so the session request is gated behind `useSession`'s own - the
 * query is `enabled: personId !== undefined` and `personId` arrives from `/api/auth/me`. Until
 * that gate opens there is nothing in flight and the page says "Loading", which is exactly what
 * `flush()` reads as a settled page: it wants one in-flight period, then two quiet samples whose
 * HTML matches. Two pumps inside that window and it returns, and the assertion underneath reads a
 * page that never loaded. CI on Node 26 did precisely that; locally it reproduces about once in
 * 550 runs, which is what makes it worth removing rather than re-running.
 *
 * Two conditions, and no `flush()` at all. The first is the one every case here shares; the second
 * is what `flush()` was actually being relied on for, said directly. `flush()` cannot be layered
 * after the first: its own guard requires the fetch count to have left zero at least once while it
 * is watching, and by the time the page has left its loading state every request has already
 * finished, so it throws "never started" - measured, 858 pumps with nothing in flight. That guard
 * is right for what it guards; it just makes the helper unusable once the waiting is over.
 *
 * See flush.test.tsx's KNOWN GAP case for the mechanism this replaces, pinned there.
 */
async function settled(client: QueryClient, html: () => string): Promise<void> {
  await pumpUntil(() => !html().includes('>Loading<'), 'the workout page to leave its loading state')
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

describe('the workout page', () => {
  it('mounts cold at its own URL, with nothing in the query cache', async () => {
    // The case approach B exists for: no other route into this page leaves the cache empty,
    // because every one of them warms it by listing the session first.
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(html()).toContain('Morning run')
    } finally { restore() }
  })

  it('falls back to the exercise type when the workout has no name of its own', async () => {
    const restore = stub({ run1: { ...RUN, attrs: { ...(RUN.attrs as object), displayName: undefined } } })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(html()).toContain('Running')
    } finally { restore() }
  })

  it('says a Google route was recorded and unreachable, when the provider flagged one and sent no points', async () => {
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')?.textContent).toBe(
        'A GPS route was recorded for this workout. This API does not return route points, so there is no map.',
      )
    } finally { restore() }
  })

  it('says nothing about a route when the provider said plainly there was nothing to record', async () => {
    window.history.replaceState(null, '', '/activity/no-gps')
    const restore = stub({ 'no-gps': NO_GPS })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')).toBeNull()
    } finally { restore() }
  })

  it('says a route was withheld, when the phone said so', async () => {
    // The one thing that can honestly be said about a workout with no route drawn: the track
    // exists and Health Connect did not release it. This is the sentence issue #330 asked for, and
    // the reason the blanket "may have been unreadable" one was removed rather than kept.
    window.history.replaceState(null, '', '/activity/withheld')
    const restore = stub({ withheld: WITHHELD })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')?.textContent).toBe(
        'A GPS route was recorded for this workout, but Health Connect withheld it, so there is no map. Open Haelan on the phone and tap Release routes to hand it over.',
      )
    } finally { restore() }
  })

  it('draws the route instead of explaining itself, when the points did arrive', async () => {
    // Consent granted since, or a different app: the flag can still be on the session while the
    // points are there, and points always win. A page that showed both would tell a household its
    // route was withheld directly above the route.
    window.history.replaceState(null, '', '/activity/withheld')
    const restore = stub({ withheld: { ...WITHHELD, route: [ROUTE_POINT] } as WorkoutSession })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')?.textContent).toBe(
        'A GPS route was recorded for this workout, drawn below.',
      )
    } finally { restore() }
  })

  it('says nothing about GPS for a companion session with no exerciseMetadata and no points', async () => {
    // PHONE carries no exerciseMetadata at all - the shape SyncEngine.kt sends - so hasGps is
    // null, meaning this app has no metadata to speak from rather than a provider saying there was
    // no route.
    //
    // This used to print "a GPS route may have been recorded, this app was not able to read it".
    // hasGps is null for EVERY companion session, so that sentence appeared under every workout
    // synced from a phone, an indoor yoga session as readily as a run, and it was false besides:
    // the app now asks for READ_EXERCISE_ROUTES and reads routes. A workout that reaches here has
    // no route points, which is overwhelmingly a workout that had no route, and the cases hiding
    // inside that are indistinguishable from the server. Saying nothing is the honest answer.
    window.history.replaceState(null, '', '/activity/phone')
    const restore = stub({ phone: PHONE })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')).toBeNull()
    } finally { restore() }
  })

  it('still says a route exists when the provider itself claims one', async () => {
    // The floor under the test above: hasGps true is Google's own claim of a route its API will
    // not send, and that sentence is the one case where this app knows more than it can draw. If
    // dropping the null sentence had swallowed this one too, the test above would still pass while
    // the page went silent about every Google workout that recorded a route.
    window.history.replaceState(null, '', '/activity/run1')
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')?.textContent).toBe(
        'A GPS route was recorded for this workout. This API does not return route points, so there is no map.',
      )
    } finally { restore() }
  })

  it('says the route is drawn below for a companion session that carried points, and drops the unreadable sentence', async () => {
    window.history.replaceState(null, '', '/activity/phone')
    const restore = stub({ phone: { ...PHONE, route: [ROUTE_POINT] } as WorkoutSession })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-gps')?.textContent).toBe(
        'A GPS route was recorded for this workout, drawn below.',
      )
    } finally { restore() }
  })

  it('renders the excluded badge with the reason the person typed', async () => {
    const excluded = { ...RUN, excluded: true, excludeReason: 'strap slipped' }
    const restore = stub({ run1: excluded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-excluded')?.textContent)
        .toBe('Excluded: strap slipped')
    } finally { restore() }
  })

  it('renders an excluded badge without a colon when no reason was typed', async () => {
    const restore = stub({ run1: { ...RUN, excluded: true, excludeReason: null } })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-excluded')?.textContent).toBe('Excluded')
    } finally { restore() }
  })

  // Review finding on this task: Shell renders `active.element` straight into `.main`, which
  // carries no card background of its own (unlike SessionList.tsx's hand-rolled states, always
  // inside a Card its caller Activity.tsx already supplies), so all three of this page's own
  // states have to bring their own Card or render as unstyled floating text. These three cases are
  // exactly what the review found nothing here exercising.
  it('shows the loading state inside a card, not as floating text, before the session request settles', () => {
    const restore = stub({ run1: RUN })
    try {
      // No flush: read the tree as it stands on the very first synchronous render, before the
      // stubbed fetch above has had any chance to resolve - the cold-load window the review found.
      const { html } = mount(<WorkoutDetail />)
      expect(container?.querySelector('.card .empty')).not.toBeNull()
      expect(html()).toContain('Loading')
    } finally { restore() }
  })

  it('wraps the missing-workout state in a card too, for a link naming a session that is not there', async () => {
    const restore = stubSessionError(404)
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.card .empty')).not.toBeNull()
      expect(html()).toContain('No such workout')
    } finally { restore() }
  })

  it('wraps a real request failure in a card too, with a retry', async () => {
    const restore = stubSessionError(500)
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.card .empty')).not.toBeNull()
      expect(html()).toContain('This did not load.')
    } finally { restore() }
  })
})

describe('the workout stat tiles', () => {
  it('shows moving time only when it differs from elapsed', async () => {
    // 54 minutes elapsed, 50 moving: two different facts, so two tiles.
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toContain('Elapsed')
      expect(labels).toContain('Moving')
    } finally { restore() }
  })

  it('drops the moving tile when the two are the same, rather than printing the same figure twice', async () => {
    const equal = { ...RUN, attrs: { ...(RUN.attrs as object), activeDuration: '3240s' } } // 54 min
    const restore = stub({ run1: equal })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toContain('Elapsed')
      expect(labels).not.toContain('Moving')
    } finally { restore() }
  })

  it('renders a tile for every field this session recorded and no tile for any it did not', async () => {
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toEqual(['Elapsed', 'Moving', 'Distance', 'Calories'])
    } finally { restore() }
  })

  it('prints a recorded zero rather than dropping the tile', async () => {
    // workoutDetail keeps a recorded 0 apart from an unrecorded field; a truthiness guard in this
    // component would undo that one line before it reaches a reader.
    const zeroed = { ...RUN, attrs: { ...(RUN.attrs as object), metricsSummary: { steps: '0' } } }
    const restore = stub({ run1: zeroed })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const tiles = [...(container?.querySelectorAll('.workout-tiles .card') ?? [])]
      const steps = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Steps')
      expect(steps?.querySelector('.value')?.textContent).toBe('0')
    } finally { restore() }
  })

  it('renders the tile section with a single Elapsed tile for a session carrying nothing but its span', async () => {
    window.history.replaceState(null, '', '/activity/bare')
    const restore = stub({ bare: BARE })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      // Elapsed is always computable from the span, so the section is present with exactly one tile.
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toEqual(['Elapsed'])
    } finally { restore() }
  })

  it('shows both cardio load tiles when both models ran', async () => {
    const loaded = { ...RUN, cardioLoad: { edwards: 100, banister: 84, banisterBasis: BASIS } }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toContain('Cardio load (Edwards)')
      expect(labels).toContain('Cardio load (Banister)')
      const tiles = [...(container?.querySelectorAll('.workout-tiles .card') ?? [])]
      const edwardsTile = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Cardio load (Edwards)')
      const banisterTile = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Cardio load (Banister)')
      // Whole-cell assertions, not substrings: '100' alone would also match a cell reading '1004'.
      expect(edwardsTile?.querySelector('.value')?.textContent).toBe('100 TRIMP')
      expect(banisterTile?.querySelector('.value')?.textContent).toBe('84 TRIMP')
    } finally { restore() }
  })

  it('shows only Edwards when Banister could not run', async () => {
    const loaded = { ...RUN, cardioLoad: { edwards: 100, banister: null, banisterBasis: null } }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).toContain('Cardio load (Edwards)')
      expect(labels).not.toContain('Cardio load (Banister)')
    } finally { restore() }
  })

  it('shows neither when the session carried no load at all', async () => {
    const loaded = { ...RUN, cardioLoad: null }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const labels = [...(container?.querySelectorAll('.workout-tiles .label') ?? [])].map((n) => n.textContent)
      expect(labels).not.toContain('Cardio load (Edwards)')
      expect(labels).not.toContain('Cardio load (Banister)')
    } finally { restore() }
  })

  // The basis is the reason these tiles are safe to show at all. Google Health shows a cardio load
  // too, and a reader comparing the two numbers has to be able to see that this one is ours - so the
  // exact copy is asserted whole here, not just checked for containing "Haelan".
  it('says the number is Haelan\'s own, not the provider\'s', async () => {
    const loaded = { ...RUN, cardioLoad: { edwards: 100, banister: null, banisterBasis: null } }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const tiles = [...(container?.querySelectorAll('.workout-tiles .card') ?? [])]
      const edwardsTile = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Cardio load (Edwards)')
      expect(edwardsTile?.querySelector('.basis')?.textContent).toBe(
        'Training impulse: minutes in each heart rate zone, weighted by zone. '
        + 'Haelan\'s own figure, and the one your weekly cardio load is built from. '
        + 'Not the number Google Health shows.',
      )
    } finally { restore() }
  })

  it('names the resting and maximum bpm the Banister figure was computed against', async () => {
    const loaded = { ...RUN, cardioLoad: { edwards: 100, banister: 84, banisterBasis: BASIS } }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const tiles = [...(container?.querySelectorAll('.workout-tiles .card') ?? [])]
      const banisterTile = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Cardio load (Banister)')
      expect(banisterTile?.querySelector('.basis')?.textContent).toBe(
        'Training impulse by a second method, from this session\'s heart rate against a resting 52 '
        + 'and a maximum 181 bpm. Shown for this workout only; nothing else in Haelan reads it. '
        + 'Not the number Google Health shows.',
      )
    } finally { restore() }
  })

  it('prints a recorded Edwards zero rather than dropping the tile', async () => {
    // Same rule as the steps zero test above, for the field this task adds: a recorded 0 is a fact,
    // not an absence, and cardioLoad?.edwards == null must not treat 0 as null via truthiness.
    const loaded = { ...RUN, cardioLoad: { edwards: 0, banister: null, banisterBasis: null } }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      const tiles = [...(container?.querySelectorAll('.workout-tiles .card') ?? [])]
      const edwardsTile = tiles.find((tile) => tile.querySelector('.label')?.textContent === 'Cardio load (Edwards)')
      expect(edwardsTile?.querySelector('.value')?.textContent).toBe('0 TRIMP')
    } finally { restore() }
  })
})

// Same shape as the splits fix below: WorkoutRoute.tsx's own card-level tests (workout-route-
// card.test.tsx) cover its rendering in isolation, but nothing there proves this page actually
// hands it `query.data.route` rather than, say, `query.data.autoSplits` by a copy-paste mistake.
// RUN itself carries no `route` field (a plain WorkoutSession, not a WorkoutSessionDetail), so the
// absence case is already exercised by every other test in this file; this pins the presence case.
describe('the route card', () => {
  it('renders the route card when the session response carries recorded points', async () => {
    const loaded = { ...RUN, route: [
      { atMs: 0, latitude: 52.00, longitude: 5, altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null },
      { atMs: 1000, latitude: 52.01, longitude: 5, altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null },
    ] }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-route-svg')).not.toBeNull()
    } finally { restore() }
  })
})

// Fix round 2: WorkoutSplits used to read autoSplits/laps off workoutDetail(session.attrs), which
// workoutSummary.ts's splitsFrom always answers as an array, absent-or-not. Once the page started
// passing the API response's own autoSplits/laps instead, that guarantee stopped being free: RUN
// and every fixture above it in this file carry neither field (they are plain WorkoutSession
// objects, not WorkoutSessionDetail), and this app has no error boundary, so an unguarded
// `.length` read on `undefined` blanked the whole page rather than only leaving the splits card
// off it. These two cases pin both directions of the fix.
describe('the splits card', () => {
  it('renders a splits table when the session response carries filled splits', async () => {
    const loaded = { ...RUN, autoSplits: [SPLIT], laps: [] }
    const restore = stub({ run1: loaded })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-splits')).not.toBeNull()
      expect(html()).toContain('Automatic splits')
    } finally { restore() }
  })

  it('still renders the rest of the page when the response carries no autoSplits or laps at all', async () => {
    // RUN itself carries neither field - the exact shape (an older cached response, or any
    // response predating this deploy) that used to throw inside WorkoutSplits and take the page
    // with it.
    const restore = stub({ run1: RUN })
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      expect(container?.querySelector('.workout-splits')).toBeNull()
      expect(html()).toContain('Morning run')
      expect(container?.querySelector('.workout-tiles')).not.toBeNull()
    } finally { restore() }
  })
})

describe('the workout page\'s own ?source= parameter', () => {
  // Final review finding: this page used to read `?source=` straight off the URL, never through
  // resolveSource (controls/source.ts) the way every sibling page does. A source id that names no
  // device this person has - a stale or foreign link, or one this person removed since - became a
  // non-null EXPLICIT choice, which suppresses useSourceTrace's own fallback rule
  // (WorkoutTrace.tsx's own comment on it). The pinned request for a source that never recorded
  // this workout comes back empty, the fallback that would otherwise answer it never fires, and the
  // trace card vanishes - reading as "no heart rate was recorded for this workout", the exact false
  // claim the fallback rule exists to prevent.
  it('treats an unrecognised source id as no choice at all, so the fallback still fires', async () => {
    window.history.replaceState(null, '', '/activity/run1?source=phantom-device')
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/sessions/run1')) return json(RUN)
      // Only 'watch' (the session's own recording device) is real; 'phantom-device' names nothing
      // this person has.
      if (url.includes('/sources')) {
        return json({
          items: [{
            id: 'watch', externalId: 'watch-ext', displayName: 'Pixel Watch 4',
            alias: null, name: 'Pixel Watch 4', kind: 'device', createdAtMs: 0,
          }],
        })
      }
      if (url.includes('/intraday/window')) {
        const source = new URLSearchParams(url.split('?')[1] ?? '').get('source') ?? ''
        // The pinned device (watch, RUN's own sourceId) recorded nothing in this window; every
        // other device did. `''` is the blended request, sent with no `source` param at all
        // (sourceParam's own rule for ALL_SOURCES) - the request the fallback sends, and the one
        // an unresolved 'phantom-device' would never reach.
        const points = source === '' ? [{ sourceId: 'phone', utcMs: Date.UTC(2026, 7, 3, 6, 10), min: 120, mean: 130, max: 140, n: 1, excluded: false }] : []
        return json({ points, reduction: null })
      }
      if (url.includes('/sessions')) return json({ items: [], cursor: null })
      return json({})
    }) as typeof fetch
    try {
      const { client, html } = mount(<WorkoutDetail />)
      await settled(client, html)
      // Absent entirely would be the old, wrong behaviour (WorkoutTrace.tsx's own rule for nobody
      // recorded anything); present with the fallback's own basis line, naming the pinned device
      // that answered empty, is what an unrecognised source id must read as instead.
      const cards = [...(container?.querySelectorAll('.card') ?? [])]
      const traceCard = cards.find((c) => c.querySelector('.label')?.textContent === 'Heart rate through this workout')
      expect(traceCard, 'the trace card was absent').not.toBeUndefined()
      expect(traceCard?.querySelector('.basis')?.textContent).toBe(
        'Pixel Watch 4 recorded no heart rate in this window, so this is every other device instead; '
        + 'this 1 point is the reading',
      )
    } finally { globalThis.fetch = original }
  })
})
