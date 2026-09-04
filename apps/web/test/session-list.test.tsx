// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SessionList } from '../src/pages/activity/SessionList.js'
import type { WorkoutSession } from '../src/data/useSessions.js'
import { ALL_SOURCES } from '../src/controls/source.js'

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

function mount(node: ReactNode, lng = 'en'): void {
  act(() => { root?.render(<I18nProvider lng={lng}>{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
}

const CONTROLS = {
  tab: 'month' as const, anchor: '2026-08-15', source: ALL_SOURCES,
  from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31',
  setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
}

const SESSIONS_KEY = queryKeys.resource('p1', 'sessions', {
  kind: 'exercise', from: CONTROLS.from, to: CONTROLS.to, source: CONTROLS.source,
})

const session = (id: string, type: string): WorkoutSession => ({
  id, sourceId: 'watch', startMs: Date.UTC(2026, 7, 3, 8, 0), endMs: Date.UTC(2026, 7, 3, 8, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: { exerciseType: type, metricsSummary: { caloriesKcal: 300 } },
})

/** Seeds the sessions response directly, so no test here depends on a network call. */
function clientWith(items: WorkoutSession[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(SESSIONS_KEY, { items, cursor: null })
  return client
}

function mountWith(items: WorkoutSession[], lng = 'nl'): void {
  const client = clientWith(items)
  mount(
    <QueryClientProvider client={client}><SessionList controls={CONTROLS} /></QueryClientProvider>,
    lng,
  )
}

/**
 * Two sessions the derivation folds into one workout: the same window, two different sources.
 * groupSessions (packages/core/src/derive/sessionOverlap.ts) unions any pair whose shared span
 * exceeds overlapRatio times the shorter one, and an identical window shares all of it, so this
 * pair is one group under every ratio below 1 and deriveExerciseDay writes workout_count 1 for
 * the day while the sessions table still holds both rows.
 */
const mergeable = (id: string, sourceId: string): WorkoutSession => ({
  ...session(id, 'RUNNING'), sourceId,
})

const selects = () => [...container!.querySelectorAll('select')] as HTMLSelectElement[]
const rows = () => container!.querySelectorAll('.session-row')

describe('SessionList', () => {
  // A scroll container hides its own length, so the count is what tells a reader whether they are
  // looking at everything.
  it('states how many sessions the period holds', () => {
    mountWith(Array.from({ length: 15 }, (_, i) => session(`s${i}`, 'RUNNING')))
    expect(container!.textContent).toContain('15')
  })

  // A filter of one option is not a filter. ControlRow already applies this ruling to the source
  // picker on Notes, where a select offering only "All sources" was choosing between nothing.
  it('offers no type filter when the range holds a single type', () => {
    mountWith([session('a', 'RUNNING'), session('b', 'RUNNING'), session('c', 'RUNNING')])
    expect(selects()).toHaveLength(0)
  })

  // The filter lists what the range holds, not the 182 the API declares. A picker offering 182
  // options of which 180 match nothing is the source picker's problem in a new place.
  it('lists only the types the range actually holds', () => {
    mountWith([session('a', 'RUNNING'), session('b', 'WALKING'), session('c', 'RUNNING')])
    const options = [...selects()[0]!.options].map((o) => o.textContent ?? '')
    expect(options).toHaveLength(3)
    expect(options.join(' ')).toContain('Hardlopen')
    expect(options.join(' ')).toContain('Wandelen')
    expect(options.join(' '), 'a type nobody logged must not be offered').not.toContain('Snowboarding')
  })

  it('shows only the chosen type once one is picked', () => {
    mountWith([session('a', 'RUNNING'), session('b', 'RUNNING'), session('c', 'WALKING')])
    expect(rows()).toHaveLength(3)

    const select = selects()[0]!
    const walking = [...select.options].find((o) => (o.textContent ?? '').includes('Wandelen'))!
    act(() => {
      select.value = walking.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(rows()).toHaveLength(1)
  })

  // Three states, three strings. An empty period and a filter matching nothing have different
  // remedies, wait longer against choose another type, so one message sends half its readers to
  // the wrong one. This is the same convention that keeps a nap absence distinct from a device
  // absence.
  //
  // The brief's own version of this test only proved the two rendered texts differ, which passes
  // even when both are wrong in different ways. Strengthened here to assert each branch's own
  // string: the empty-period render must contain the empty-period copy and must not contain the
  // filtered-empty copy, and the reverse for the filtered branch.
  //
  // Building a genuine "filter matches nothing" state needs a fixture the given scaffold cannot
  // produce: SessionList only ever offers types the current range holds, so no click available in
  // the UI can select a type with zero rows. The one way a filter selection and the data it was
  // built from can disagree is if the data changes under it without unmounting the component,
  // which SessionList allows on purpose (the filter is not reset when a query answers again, the
  // same way ControlRow's own range and source survive a refetch). Selecting WALKING and then
  // updating the cached query response to drop the WALKING session reaches exactly that state: a
  // non-empty period whose chosen filter now matches nothing.
  it('distinguishes an empty period from a filter that matches nothing', async () => {
    // A throwaway container and root of its own, rather than the beforeEach-managed one below:
    // React 19 refuses a render() on a root once it has been unmounted ("Cannot update an
    // unmounted root"), so capturing this tree's text and then reusing the same root for the
    // second mount, the way the brief's own scaffold does it, throws before either assertion
    // runs. This tree's text is read once and discarded, so it does not need to survive past that.
    const scratch = document.createElement('div')
    document.body.appendChild(scratch)
    const scratchRoot = createRoot(scratch)
    act(() => {
      scratchRoot.render(
        <I18nProvider lng="nl">
          <QueryClientProvider client={clientWith([])}><SessionList controls={CONTROLS} /></QueryClientProvider>
        </I18nProvider>,
      )
    })
    const emptyPeriod = scratch.textContent ?? ''
    act(() => { scratchRoot.unmount() })
    scratch.remove()

    const client = clientWith([session('a', 'RUNNING'), session('b', 'WALKING')])
    mount(<QueryClientProvider client={client}><SessionList controls={CONTROLS} /></QueryClientProvider>, 'nl')

    const select = selects()[0]!
    const walking = [...select.options].find((o) => (o.textContent ?? '').includes('Wandelen'))!
    act(() => {
      select.value = walking.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(rows()).toHaveLength(1)

    // The period's own data moves on (a step, a resync) while the WALKING filter stays chosen;
    // its one session is gone, but the period itself is not empty. TanStack Query's own
    // notifyManager schedules observer notifications through setTimeout(fn, 0), a real macrotask
    // rather than a microtask, so an async act with no timer inside it resolves before the
    // subscribed component ever re-renders; the explicit zero-delay wait is what lets that
    // notification actually run before the assertion below reads the DOM.
    await act(async () => {
      client.setQueryData(SESSIONS_KEY, { items: [session('a', 'RUNNING')], cursor: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(rows()).toHaveLength(0)
    const filtered = container!.textContent ?? ''

    expect(emptyPeriod).toContain('Geen activiteiten geregistreerd in deze periode.')
    expect(emptyPeriod, 'the empty-period message must not also read as the filtered-empty one')
      .not.toContain('Geen Wandelen sessies in deze periode.')

    expect(filtered).toContain('Geen Wandelen sessies in deze periode.')
    expect(filtered, 'the filtered-empty message must not also read as the empty-period one')
      .not.toContain('Geen activiteiten geregistreerd in deze periode.')
  })
  // The Workouts tile above this list sums merged `daily` workout_count, which counts a run
  // recorded by a watch and a phone once; this list counts the rows the sessions table holds,
  // which counts it twice. Live data: 186 against 192 over seven months, differing on six days.
  // The two are different quantities and stay different quantities, so the list has to name its
  // own rather than print a bare "2 sessions" a reader will read as the tile's word for them.
  it('names its own quantity rather than the one the workout tile counts', () => {
    mountWith([mergeable('a', 'watch'), mergeable('b', 'phone')], 'en')
    expect(rows(), 'both rows are shown; only the tile above collapses them').toHaveLength(2)
    expect(container!.querySelector('.session-list-count')!.textContent)
      .toBe('2 recorded sessions in this period')
    expect(container!.querySelector('.session-list .basis')!.textContent)
      .toBe('One row per recorded session. The Workouts tile counts a workout once even when two devices recorded it, so it can read lower.')
  })
})
