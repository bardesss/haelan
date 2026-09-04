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

const session = (id: string, type: string, over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id, sourceId: 'watch', startMs: Date.UTC(2026, 7, 3, 8, 0), endMs: Date.UTC(2026, 7, 3, 8, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
  attrs: { exerciseType: type, metricsSummary: { caloriesKcal: 300 } },
  excluded: false, excludeReason: null,
  ...over,
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
  // The stranding case. SessionList deliberately never resets selectedType when the data changes
  // (the filtered-empty message depends on the selection outliving the rows it was built from),
  // so a reader who picks WALKING and then steps into a period holding only RUNNING has a filter
  // matching nothing. Hiding the select at one option, the ruling the test above pins, then took
  // away the only control that could clear it: no select, no rows, and "choose another type" with
  // nothing to choose with. Reachable on real data, where two of 31 weeks hold exactly one type
  // and nearly every Day range does.
  it('keeps the type control on screen when the chosen type leaves the range', async () => {
    const client = clientWith([session('a', 'RUNNING'), session('b', 'WALKING')])
    mount(<QueryClientProvider client={client}><SessionList controls={CONTROLS} /></QueryClientProvider>, 'nl')

    const chosen = [...selects()[0]!.options].find((o) => (o.textContent ?? '').includes('Wandelen'))!.value
    act(() => {
      selects()[0]!.value = chosen
      selects()[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The period moves on to one holding a single type, WALKING gone, the WALKING filter still set.
    await act(async () => {
      client.setQueryData(SESSIONS_KEY, { items: [session('a', 'RUNNING')], cursor: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(rows(), 'the filter still matches nothing, which is the state being escaped from').toHaveLength(0)

    expect(selects(), 'a filter with a selection always needs a control to clear it').toHaveLength(1)
    const select = selects()[0]!
    // Not merely rendered: showing the real selection back. A browser select silently falls an
    // unmatched controlled value to whichever option renders first, so a select whose chosen type
    // is missing from its own options would read "Alle types" over WALKING-filtered rows.
    expect(select.value, 'the control has to show the type actually filtering the rows').toBe(chosen)

    const all = [...select.options].find((o) => (o.textContent ?? '').includes('Alle types'))!
    act(() => {
      select.value = all.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(rows(), 'and clearing it brings the period back').toHaveLength(1)
  })
  // The header count read filtered.length into a string ending "in this period", so a filter on a
  // four session month claimed the month held one. Worse in the filtered-empty branch, where "0
  // recorded sessions in this period" sat directly above "choose another type to see the rest of
  // this period's sessions": two sentences on one screen, one of them saying there is nothing to
  // come back to.
  const count = () => container!.querySelector('.session-list-count')!.textContent

  it('counts the period, and says so against the total once a filter narrows it', () => {
    mountWith([session('a', 'RUNNING'), session('b', 'RUNNING'), session('c', 'RUNNING'),
      session('d', 'WALKING')], 'en')
    expect(count()).toBe('4 recorded sessions in this period')

    const select = selects()[0]!
    const walking = [...select.options].find((o) => (o.textContent ?? '').includes('Walking'))!
    act(() => {
      select.value = walking.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(count()).toBe('1 of 4 recorded sessions in this period')
  })

  it('does not tell a reader the period is empty while telling them to filter it differently', async () => {
    const client = clientWith([session('a', 'RUNNING'), session('b', 'WALKING')])
    mount(<QueryClientProvider client={client}><SessionList controls={CONTROLS} /></QueryClientProvider>, 'en')

    const select = selects()[0]!
    const walking = [...select.options].find((o) => (o.textContent ?? '').includes('Walking'))!
    act(() => {
      select.value = walking.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      client.setQueryData(SESSIONS_KEY, { items: [session('a', 'RUNNING')], cursor: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(rows()).toHaveLength(0)
    expect(count()).toBe('0 of 1 recorded sessions in this period')
    expect(container!.textContent, 'the remedy offered has to still be true')
      .toContain("Choose another type to see the rest of this period's sessions.")
  })
  // The inner scroll container this test used to pin (max-height: 480px, its own tab stop) is
  // gone: the page around this card already scrolls, so a second scrollbar inside it only trapped
  // the wheel and clipped the first row. Removing it removes the keyboard trap it existed to
  // patch too, so there is nothing left here to reach with Tab.
  it('no longer wraps the rows in a scrolling container', () => {
    mountWith(Array.from({ length: 15 }, (_, i) => session(`s${i}`, 'RUNNING')), 'en')
    expect(container!.querySelector('.session-list-scroll')).toBeNull()
  })

  // Five sessions on one day used to print their own date five times. Grouping by localDate is
  // what stops that: one heading per run of consecutive same-day rows, in the order the rows
  // already sorted into (newest first), never resorted by the grouping itself.
  it('prints one date heading per day, in the same newest-first order as the rows', () => {
    mountWith([
      session('a', 'RUNNING', { localDate: '2026-08-27', startMs: Date.UTC(2026, 7, 27, 8, 0), endMs: Date.UTC(2026, 7, 27, 8, 28) }),
      session('b', 'RUNNING', { localDate: '2026-08-27', startMs: Date.UTC(2026, 7, 27, 7, 0), endMs: Date.UTC(2026, 7, 27, 7, 24) }),
      session('c', 'WALKING', { localDate: '2026-08-24', startMs: Date.UTC(2026, 7, 24, 8, 0), endMs: Date.UTC(2026, 7, 24, 8, 43) }),
    ], 'nl')

    const headings = [...container!.querySelectorAll('.session-date-heading')].map((h) => h.textContent)
    // Two headings for three rows: the two 27th sessions share one heading rather than each
    // printing their own, which is the defect this change exists to fix.
    expect(headings).toEqual(['donderdag 27 augustus', 'maandag 24 augustus'])
    expect(rows()).toHaveLength(3)
  })

  // The heading carries the date now (SessionRow itself stops printing it, see session-row.test),
  // through the same Intl call SessionRow's own sr-only span uses, not a hand built string: the
  // full Dutch weekday and date is the one shape a hand built format is likeliest to get wrong
  // ("do 27 aug" is not "donderdag 27 augustus").
  it('spells the heading as the full weekday and date, not an abbreviation', () => {
    mountWith([session('a', 'RUNNING', { localDate: '2026-08-27' })], 'nl')
    expect(container!.querySelector('.session-date-heading')!.textContent).toBe('donderdag 27 augustus')
  })
})
