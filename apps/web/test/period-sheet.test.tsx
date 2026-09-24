// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import { PHONE_MAX_WIDTH } from '../src/ui/breakpoint.js'

/**
 * The control row below the breakpoint: one line, and a sheet behind it.
 *
 * Nothing in control-row.test.tsx can reach this. useIsPhone reads matchMedia, happy-dom's own
 * matchMedia always answers false, and the desktop row is what every other test in this suite
 * therefore renders - which is correct for those tests and blind for this one. So matchMedia is
 * stubbed here, per test, against the same constant the stylesheet's media query is built from.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

/** Answers "this is a phone" for the rail's own query and nothing else. */
function pretendWidth(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width <= PHONE_MAX_WIDTH && query.includes(`${PHONE_MAX_WIDTH}px`),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

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
  vi.unstubAllGlobals()
})

function mount(node: ReactNode, lng = 'en'): void {
  act(() => { root?.render(<I18nProvider lng={lng}>{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: [] })
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

const chip = (): HTMLButtonElement => container!.querySelector('[data-testid="period-chip"]') as HTMLButtonElement
const click = (element: HTMLElement): void => {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('the control row on a phone', () => {
  beforeEach(() => { pretendWidth(375) })

  // The whole point of the change: five stacked rows of chrome became one. A reader's first
  // number used to be 268px down the page.
  it('renders one row - the two arrows and a chip, and nothing else', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} exportPath="/x.csv" />))
    expect(chip()).not.toBeNull()
    // The five-across range strip, the separate date input, the source picker and the export link
    // are all behind the chip now. None of them is in the row itself.
    expect(container!.querySelector('.controls > .segmented')).toBeNull()
    expect(container!.querySelector('.controls-end')).toBeNull()
  })

  it('names the range and the period on the chip', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} />))
    expect(chip().textContent).toContain('Month')
    expect(chip().textContent).toContain('August 2026')
  })

  // "August 2026" alone does not say whether you are looking at that month or at the three ending
  // in it, and a screen reader gets only the accessible name.
  it('says both halves in the accessible name too', () => {
    mount(withQuery(<ControlRow controls={stubControls({ tab: '3months' })} sources={[]} />))
    expect(chip().getAttribute('aria-label')).toContain('3 months')
  })

  // The reason the arrows stayed outside the sheet. Stepping is the frequent action; charging it
  // a sheet to save the rare controls a row would be a worse trade than the one being fixed.
  it('steps without opening anything', () => {
    const steps: number[] = []
    mount(withQuery(<ControlRow controls={stubControls({ step: (d) => steps.push(d) })} sources={[]} />))
    const arrows = [...container!.querySelectorAll('.stepper .icon-button')] as HTMLButtonElement[]
    click(arrows[0]!)
    click(arrows[1]!)
    expect(steps).toEqual([-1, 1])
    expect(container!.querySelector('dialog')!.hasAttribute('open')).toBe(false)
  })

  it('opens the sheet from the chip', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} />))
    expect(container!.querySelector('dialog')!.hasAttribute('open')).toBe(false)
    click(chip())
    expect(container!.querySelector('dialog')!.hasAttribute('open')).toBe(true)
  })

  it('offers every range in the sheet and marks the current one', () => {
    mount(withQuery(<ControlRow controls={stubControls({ tab: 'week' })} sources={[]} />))
    click(chip())
    const options = [...container!.querySelectorAll('.period-option')]
    expect(options).toHaveLength(5)
    expect(options.filter((o) => o.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
  })

  // Choosing is the answer the reader opened the sheet for. Leaving it up over the page they just
  // changed makes them dismiss it twice.
  it('applies a range and closes itself', () => {
    const chosen: string[] = []
    mount(withQuery(<ControlRow controls={stubControls({ setTab: (t) => chosen.push(t) })} sources={[]} />))
    click(chip())
    click(container!.querySelectorAll('.period-option')[1] as HTMLElement)
    expect(chosen).toEqual(['week'])
    expect(container!.querySelector('dialog')!.hasAttribute('open')).toBe(false)
  })

  // A phone has no Escape key, and a backdrop tap is a real dismissal but not a discoverable one.
  it('closes from its own close button', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} />))
    click(chip())
    click(container!.querySelector('[data-testid="period-sheet-close"]') as HTMLElement)
    expect(container!.querySelector('dialog')!.hasAttribute('open')).toBe(false)
  })

  it('carries the source picker and the export into the sheet', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} exportPath="/x.csv" />))
    click(chip())
    expect(container!.querySelector('.period-sheet select')).not.toBeNull()
    expect(container!.querySelector('.period-sheet a[href="/x.csv"]')).not.toBeNull()
  })

  // The same ruling ControlRow makes above the breakpoint: Notes passes no sources at all, and a
  // select holding only "All sources" chooses between nothing.
  it('draws no source picker in the sheet when there are no sources', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={[]} />))
    click(chip())
    expect(container!.querySelector('.period-sheet select')).toBeNull()
  })
})

describe('the control row above the breakpoint', () => {
  beforeEach(() => { pretendWidth(1200) })

  it('keeps the full row rather than the chip', () => {
    mount(withQuery(<ControlRow controls={stubControls()} sources={['watch']} exportPath="/x.csv" />))
    expect(container!.querySelector('[data-testid="period-chip"]')).toBeNull()
    expect(container!.querySelectorAll('.segment')).toHaveLength(5)
    expect(container!.querySelector('.controls-end')).not.toBeNull()
  })
})
