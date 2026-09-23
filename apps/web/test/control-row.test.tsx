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
import { ControlRow } from '../src/components/ControlRow.js'
import type { PageControlsState } from '../src/controls/usePageControls.js'
import { syncStatusKey } from '../src/data/useSyncStatus.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
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

/**
 * Mounts a tree and flushes effects, wrapped in a real I18nProvider rather than the
 * renderToStaticMarkup pattern the rest of the suite uses for static copy: this component sets
 * real click and change handlers, and those only exist once the tree is mounted for real.
 */
function mount(node: ReactNode, lng = 'en'): void {
  act(() => { root?.render(<I18nProvider lng={lng}>{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * ControlRow now reads the session, the sync status and the source names through TanStack Query
 * (Task 12, then this milestone), so every mount needs a client in the tree even though none of
 * these tests exercise any of the three. All three are seeded directly rather than left to fetch,
 * the same way page-controls.test.tsx seeds the session: an unmocked fetch to any of the three
 * routes would be a real network call in this environment, not merely a slow one.
 */
function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(syncStatusKey(PERSON.personId), {
    running: false, lastFinishedAtMs: null,
    rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] },
  })
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: [] })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

/**
 * The same tree with no sync status cached and nothing answering for it, which is the state every
 * page is in for the first moment after it mounts. Separate from withQuery rather than an
 * optional argument, for the reason data-hooks.test.tsx gives: an optional parameter defaults
 * when a caller passes undefined explicitly, so a test meaning to withhold the status would
 * quietly get it anyway.
 */
function withQueryAwaitingStatus(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

function stubControls(over: Partial<PageControlsState> = {}): PageControlsState {
  return {
    tab: 'month', anchor: '2026-08-15', source: ALL_SOURCES,
    from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31', today: '2026-08-31',
    setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
    ...over,
  }
}

describe('ControlRow', () => {
  it('marks the active range and only the active range', () => {
    mount(withQuery(<ControlRow controls={stubControls({ tab: 'week' })} sources={['merged']} />))
    const pressed = [...container!.querySelectorAll('.segment')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
  })

  // The defect this catches is the one the component shipped with: aria-pressed set correctly
  // and no handler behind it, so it looked right and did nothing.
  it('calls setTab when a range is clicked', () => {
    const chosen: string[] = []
    mount(withQuery(<ControlRow controls={stubControls({ setTab: (t) => chosen.push(t) })} sources={['merged']} />))
    const segments = [...container!.querySelectorAll('.segment')] as HTMLButtonElement[]
    act(() => { segments[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(chosen).toHaveLength(1)
  })

  it('steps backwards and forwards through the stepper buttons', () => {
    const steps: number[] = []
    mount(withQuery(<ControlRow controls={stubControls({ step: (d) => steps.push(d) })} sources={['merged']} />))
    const buttons = [...container!.querySelectorAll('.stepper .icon-button')] as HTMLButtonElement[]
    act(() => { buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(steps).toEqual([-1, 1])
  })

  it('sets the anchor from the calendar picker', () => {
    const picked: string[] = []
    mount(withQuery(<ControlRow controls={stubControls({ setAnchor: (a) => picked.push(a) })} sources={['merged']} />))
    const picker = container!.querySelector('input[type="date"]') as HTMLInputElement
    // React installs its own setter on a controlled input's value property to track what it last
    // rendered. Assigning picker.value directly goes through that same setter, which quietly
    // updates the tracker too, so the later event finds nothing changed and onChange never fires,
    // pass or fail, no matter what the handler does. Going through the native prototype setter
    // first bypasses React's tracking exactly the way a real keystroke or picker selection would,
    // and 'input' rather than 'change' is the event React actually listens for on a date input.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    nativeValueSetter.call(picker, '2026-09-02')
    act(() => { picker.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(picked).toEqual(['2026-09-02'])
  })

  // The anchor date used to print beside the period's own label ("August 2026  15-08-2026") and
  // read as a second period. The picker is now an icon with the input laid transparent over it:
  // the input still exists, labelled, for a keyboard and a screen reader, but it prints nothing.
  it('prints the period once, with the date picker as an icon rather than a second date', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['merged']} />))
    const picker = container!.querySelector('.stepper .date-pick')
    expect(picker, container!.innerHTML).not.toBeNull()
    expect(picker!.querySelector('svg')).not.toBeNull()
    const input = picker!.querySelector('input[type="date"]') as HTMLInputElement
    expect(input.className).toBe('date-pick-input')
    expect(input.getAttribute('aria-label')).toBe('Pick a date')
    // The icon's wrapper is not a button, so the stepper's two icon buttons are still the arrows.
    expect(container!.querySelectorAll('.stepper .icon-button')).toHaveLength(2)
  })

  it('says what the change badges compare only on a page that asks for it', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['merged']} trendNote />))
    expect(container!.querySelector('.control-row-note')?.textContent)
      .toBe("Each percentage compares the later half of that card's readings with the earlier half.")
    act(() => { root?.render(<I18nProvider lng="en">{withQuery(<ControlRow controls={stubControls()} sources={['merged']} />)}</I18nProvider>) })
    expect(container!.querySelector('.control-row-note')).toBeNull()
  })

  it('offers the all sources sentinel plus every source the person has, and marks the chosen one', () => {
    mount(withQuery(<ControlRow controls={stubControls({ source: 'watch' })} sources={['watch', 'phone']} />))
    const select = container!.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual([ALL_SOURCES, 'watch', 'phone'])
    expect(select.value).toBe('watch')
  })

  // Notes hands this component `sources={[]}` (Notes.tsx: a note or an event has no source
  // dimension), and the unconditional select used to draw anyway, holding one option, "All
  // sources", choosing between nothing. A picker of one choice is not a picker.
  it('draws no source picker when there are no sources', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} />))
    expect(container!.querySelector('select')).toBeNull()
  })

  // Every assertion about the sync button and its freshness line moved to sync-control.test.tsx
  // when M10 moved the control itself out of this row and into the shell. What belongs here now
  // is the opposite claim: that this row no longer carries either of them.
  it('carries no sync control of its own', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} />))
    expect(container!.querySelector('.sync-control')).toBeNull()
    expect(container!.querySelector('.synced')).toBeNull()
    expect(container!.textContent).not.toContain('Synced')
  })

  // A page has one accent-filled control at most, and this row's job is choosing what to look at.
  // Nothing in it is the thing a reader came to the page to press.
  it('leaves the accent style to the page rather than spending it on a control', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} exportPath="/x.csv" />))
    expect(container!.querySelector('.button-primary')).toBeNull()
  })

  // no-hardcoded-strings.test.ts cannot see this one: its regex reads text between tags, not
  // inside an expression, so an English "to" sat in the stepper label of a Dutch page while every
  // card underneath it read Dutch.
  it('names the period in the page language, and keeps the catalogue word on the exact bounds', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} />), 'nl')
    const label = container!.querySelector('.stepper-label')!
    // The visible label is no longer a join of two dates at all: it names the period, in the
    // page's own language, through Intl rather than the catalogue. Both halves are asserted here
    // because either one alone passes while the other is broken: an English month name beside a
    // correct Dutch title, or a Dutch name beside bounds joined by an English "to".
    expect(label.textContent).toBe('augustus 2026')
    expect(label.getAttribute('title')).toBe('2026-08-01 tot en met 2026-08-31')
  })

  // The export is left out rather than rendered as an anchor going nowhere. This used to share a
  // test with `canSync`, a prop no page ever set to false, which went with the sync button.
  it('draws no export link on a page that offers no path for one', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} />))
    expect(container!.querySelector('a.button')).toBeNull()
  })

  // The fallback that used to live here now lives in the state layer, where the page builds its
  // requests from the same value: see source.test.ts, and dashboard-round-trip.test.tsx for the
  // page level version. Nothing is asserted here about an unmatched value, because nothing here
  // could: a browser select silently defaults one to its first option no matter what this
  // component does.
})

const text = (selector: string): string => container!.querySelector(selector)?.textContent ?? ''

describe('a source that stopped inside the range', () => {
  it('names it, so a thinning chart is explained where the reader is looking', () => {
    mount(withQuery(
      <ControlRow controls={stubControls({ tab: 'month' })} sources={['watch']}
        stoppedSources={['watch']} />,
    ))
    expect(text('.control-row-stopped')).toBe('Stopped reporting during this range: watch.')
  })

  it('names all of them when more than one stopped', () => {
    mount(withQuery(
      <ControlRow controls={stubControls({ tab: 'month' })} sources={['watch', 'scale']}
        stoppedSources={['watch', 'scale']} />,
    ))
    // Intl.ListFormat, so the conjunction is the language's own rather than a hardcoded "and".
    expect(text('.control-row-stopped')).toBe('Stopped reporting during this range: watch and scale.')
  })

  it('says nothing when none stopped', () => {
    mount(withQuery(
      <ControlRow controls={stubControls({})} sources={['watch']}
        stoppedSources={[]} />,
    ))
    expect(container!.querySelector('.control-row-stopped')).toBeNull()
  })

  it('says nothing at all when the page passes none, which is every page that has not adopted it', () => {
    mount(withQuery(<ControlRow controls={stubControls({})} sources={['watch']} />))
    expect(container!.querySelector('.control-row-stopped')).toBeNull()
  })
})
