// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { MetricCard } from '../src/components/MetricCard.js'
import type { SeriesPoint } from '../src/data/useSeries.js'

// No I18nProvider anywhere in this file, on purpose: with no i18next instance initialised, t()
// falls back to returning the key it was asked for, so asserting on 'errorState.title' or on the
// literal basisKey/basisWornKey strings passed in below is asserting on the key MetricCard chose,
// not on translated copy a locale file could change out from under this test.
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

function mount(node: React.ReactElement): void {
  act(() => { root?.render(node) })
}

const OK = { isError: false, isPending: false, refetch: () => {} }
const point = (value: number, coverage: number | null): SeriesPoint =>
  ({ localDate: '2026-08-01', source: 'merged', value, coverage, sourceMix: null, updatedAtMs: null })

describe('MetricCard', () => {
  // Error outranks pending, and this is the case that inverts if the order is wrong: an errored
  // query has isPending false and data undefined, which emptyStateFor reads as "no data yet", so
  // a 500 would render as a statement about the person's record.
  it('renders the error state for a failed request, not an empty period', () => {
    mount(<MetricCard metric="steps" span={1} query={{ isError: true, isPending: false, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>)
    expect(container!.textContent).toContain('errorState.title')
    expect(container!.textContent).not.toContain('emptyState.no_data.title')
  })

  // The only input where the order between the two checks is actually observable: isError and
  // isPending are mutually exclusive for a single query, so a plain line swap between them is a
  // no-op there. A composite query is not single, though. Dashboard.tsx already ORs several
  // queries into one of this exact shape (heartRateFailed, heartRatePending), and an OR of three
  // isError flags and an OR of three isPending flags can both be true at once when one series has
  // failed while another is still in flight. That is the case this test pins.
  it('still shows the error when a composite query is both errored and pending', () => {
    mount(<MetricCard metric="steps" span={1} query={{ isError: true, isPending: true, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>)
    expect(container!.textContent).toContain('errorState.title')
    expect(container!.textContent).not.toContain('common.loading')
  })

  it('claims nothing at all while the query is pending', () => {
    mount(<MetricCard metric="steps" span={1} query={{ isError: false, isPending: true, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>)
    expect(container!.textContent).not.toContain('drawn')
    expect(container!.textContent).not.toContain('emptyState')
  })

  it('renders a genuine zero as data rather than as emptiness', () => {
    mount(<MetricCard metric="steps" span={1} query={OK} points={[point(0, 0.9)]}
      basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>)
    expect(container!.textContent).toContain('drawn')
  })

  // A band computed from three days looks exactly as authoritative as one computed from thirty,
  // and an absent baseline is not a thin one: a card that never asked must not be told its data
  // is insufficient.
  it('tells a thin baseline apart from an absent one', () => {
    mount(<MetricCard metric="steps" span={1} query={OK} points={[point(900, 0.9)]}
      baseline={{ center: 900, spread: 10, n: 3, thin: true }}
      basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>)
    expect(container!.textContent).toContain('emptyState.insufficient.title')

    act(() => { root!.render(<MetricCard metric="steps" span={1} query={OK} points={[point(900, 0.9)]}
      basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>) })
    expect(container!.textContent).toContain('drawn')
  })

  // The whole reason this component exists. The basis reaches the renderer, so a card cannot
  // print one claim while drawing another.
  it('hands the basis to the renderer rather than letting a page compute its own', () => {
    mount(<MetricCard metric="steps" span={1} query={OK} points={[point(900, 0.9)]}
      basisKey="b" basisWornKey="bw">{(basis) => <span>{basis}</span>}</MetricCard>)
    expect(container!.textContent).toContain('bw')
  })

  it('chooses the plain basis for a metric that carries no wear signal', () => {
    mount(<MetricCard metric="sleep_asleep_minutes" span={1} query={OK} points={[point(420, null)]}
      basisKey="b" basisWornKey="bw">{(basis) => <span>{basis}</span>}</MetricCard>)
    expect(container!.textContent).toContain('b')
    expect(container!.textContent).not.toContain('bw')
  })
})
