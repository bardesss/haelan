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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
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
  client.setQueryData(syncStatusKey(PERSON.personId), { running: false, lastFinishedAtMs: null })
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
    from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31',
    setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
    ...over,
  }
}

describe('ControlRow', () => {
  it('marks the active range and only the active range', () => {
    mount(withQuery(<ControlRow controls={stubControls({ tab: 'week' })} sources={['merged']} syncedMinutesAgo={4} />))
    const pressed = [...container!.querySelectorAll('.segment')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
  })

  // The defect this catches is the one the component shipped with: aria-pressed set correctly
  // and no handler behind it, so it looked right and did nothing.
  it('calls setTab when a range is clicked', () => {
    const chosen: string[] = []
    mount(withQuery(<ControlRow controls={stubControls({ setTab: (t) => chosen.push(t) })} sources={['merged']} syncedMinutesAgo={4} />))
    const segments = [...container!.querySelectorAll('.segment')] as HTMLButtonElement[]
    act(() => { segments[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(chosen).toHaveLength(1)
  })

  it('steps backwards and forwards through the stepper buttons', () => {
    const steps: number[] = []
    mount(withQuery(<ControlRow controls={stubControls({ step: (d) => steps.push(d) })} sources={['merged']} syncedMinutesAgo={4} />))
    const buttons = [...container!.querySelectorAll('.stepper .icon-button')] as HTMLButtonElement[]
    act(() => { buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(steps).toEqual([-1, 1])
  })

  it('sets the anchor from the calendar picker', () => {
    const picked: string[] = []
    mount(withQuery(<ControlRow controls={stubControls({ setAnchor: (a) => picked.push(a) })} sources={['merged']} syncedMinutesAgo={4} />))
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

  it('offers the all sources sentinel plus every source the person has, and marks the chosen one', () => {
    mount(withQuery(<ControlRow controls={stubControls({ source: 'watch' })} sources={['watch', 'phone']} syncedMinutesAgo={4} />))
    const select = container!.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual([ALL_SOURCES, 'watch', 'phone'])
    expect(select.value).toBe('watch')
  })

  // Notes hands this component `sources={[]}` (Notes.tsx: a note or an event has no source
  // dimension), and the unconditional select used to draw anyway, holding one option, "All
  // sources", choosing between nothing. A picker of one choice is not a picker.
  it('draws no source picker when there are no sources', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} syncedMinutesAgo={4} />))
    expect(container!.querySelector('select')).toBeNull()
  })

  // "Synced 0 min ago" reads as "synced seconds ago", and it was what a fresh instance and a
  // page still loading both printed. A missing copy string is not a reason to print a false one.
  it('says never synced rather than zero minutes ago when no run has finished', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} syncedMinutesAgo={null} />))
    expect(container!.textContent).toContain('Never synced')
    expect(container!.textContent).not.toContain('Synced 0 min ago')
  })

  it('says the status is unknown while it is still being read', () => {
    const original = globalThis.fetch
    // Never settles: this is the moment between mount and the status route answering.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    mount(withQueryAwaitingStatus(<ControlRow controls={stubControls()} sources={[]} syncedMinutesAgo={null} />))
    expect(container!.textContent).toContain('Sync status unknown')
    expect(container!.textContent).not.toContain('Never synced')
    globalThis.fetch = original
  })

  it('still reports a real time as one', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} syncedMinutesAgo={7} />))
    expect(container!.textContent).toContain('Synced 7 min ago')
  })

  // no-hardcoded-strings.test.ts cannot see this one: its regex reads text between tags, not
  // inside an expression, so an English "to" sat in the stepper label of a Dutch page while every
  // card underneath it read Dutch.
  it('names the period in the page language, and keeps the catalogue word on the exact bounds', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} syncedMinutesAgo={4} />), 'nl')
    const label = container!.querySelector('.stepper-label')!
    // The visible label is no longer a join of two dates at all: it names the period, in the
    // page's own language, through Intl rather than the catalogue. Both halves are asserted here
    // because either one alone passes while the other is broken: an English month name beside a
    // correct Dutch title, or a Dutch name beside bounds joined by an English "to".
    expect(label.textContent).toBe('augustus 2026')
    expect(label.getAttribute('title')).toBe('2026-08-01 tot en met 2026-08-31')
  })

  // Before this branch the whole row was inert everywhere, so a placeholder was obviously a mock.
  // The sync button now really posts and the label really claims a time, which a page pinned to
  // fixtures cannot honour.
  it('hides the sync and download controls on a page that cannot honour them', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} syncedMinutesAgo={null} canSync={false} />))
    expect(container!.querySelector('.button-primary')).toBeNull()
    expect(container!.querySelector('.synced')).toBeNull()
    expect(container!.querySelector('a.button')).toBeNull()
  })

  // The fallback that used to live here now lives in the state layer, where the page builds its
  // requests from the same value: see source.test.ts, and dashboard-round-trip.test.tsx for the
  // page level version. Nothing is asserted here about an unmatched value, because nothing here
  // could: a browser select silently defaults one to its first option no matter what this
  // component does.
})
