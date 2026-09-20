// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MetricCard } from '../src/components/MetricCard.js'
import type { SeriesPoint } from '../src/data/useSeries.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { dataTypesKey } from '../src/data/useDataTypes.js'
import type { DataTypeChoice } from '../src/data/useDataTypes.js'

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

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * MetricCard now reads useDataTypes() itself (Task 8), the way ControlRow already reads the
 * session, the sync status and the source names, so every mount needs a client in the tree even
 * for a test that means to exercise no exclusion at all. Seeded directly rather than left to
 * fetch, control-row.test.tsx's own reason: an unmocked fetch to either route would be a real
 * network call in this environment, not merely a slow one.
 */
function withQuery(node: ReactNode, items: DataTypeChoice[] = []): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(dataTypesKey(PERSON.personId), { items })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

/**
 * The same tree, with the data types query left deliberately UNSEEDED and its request hung, so
 * `useDataTypes()` reports isPending the way it really does on a cold load.
 *
 * The session is still seeded, because that is what the real cold load looks like by the time a
 * MetricCard can reach the exclusion question at all: useSeries carries the same
 * `enabled: personId !== undefined` guard useDataTypes does, so a settled series query already
 * implies a resolved session. Hanging rather than resolving, control-row.test.tsx's own reason
 * inverted: an unseeded query would otherwise make a real network call in this environment, and
 * a resolving one would settle before the assertion and prove nothing.
 */
function withDataTypesInFlight(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

let restoreFetch: (() => void) | null = null
afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

const OK = { isError: false, isPending: false, refetch: () => {} }
const point = (value: number, coverage: number | null): SeriesPoint =>
  ({ localDate: '2026-08-01', source: 'merged', value, coverage, sourceMix: null, updatedAtMs: null, filled: false })

describe('MetricCard', () => {
  // Error outranks pending, and this is the case that inverts if the order is wrong: an errored
  // query has isPending false and data undefined, which emptyStateFor reads as "no data yet", so
  // a 500 would render as a statement about the person's record.
  it('renders the error state for a failed request, not an empty period', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={{ isError: true, isPending: false, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
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
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={{ isError: true, isPending: true, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.textContent).toContain('errorState.title')
    expect(container!.textContent).not.toContain('common.loading')
  })

  it('claims nothing at all while the query is pending', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={{ isError: false, isPending: true, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.textContent).not.toContain('drawn')
    expect(container!.textContent).not.toContain('emptyState')
  })

  it('renders a genuine zero as data rather than as emptiness', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK} points={[point(0, 0.9)]}
      basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.textContent).toContain('drawn')
  })

  // The whole reason this component exists. The basis reaches the renderer, so a card cannot
  // print one claim while drawing another.
  it('hands the basis to the renderer rather than letting a page compute its own', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK} points={[point(900, 0.9)]}
      basisKey="b" basisWornKey="bw">{(basis) => <span>{basis}</span>}</MetricCard>))
    expect(container!.textContent).toContain('bw')
  })

  it('chooses the plain basis for a metric that carries no wear signal', () => {
    mount(withQuery(<MetricCard metric="sleep_asleep_minutes" span={1} basisPlacement="body" query={OK} points={[point(420, null)]}
      basisKey="b" basisWornKey="bw">{(basis) => <span>{basis}</span>}</MetricCard>))
    expect(container!.textContent).toContain('b')
    expect(container!.textContent).not.toContain('bw')
  })

  // The Critical this component shipped once: Card renders `basis` unconditionally whenever it is
  // handed one, so a 'body' caller whose children already print the basis through its own StatTile
  // must not also receive it on Card, or the reader sees the same sentence twice.
  it('prints the basis exactly once when placement is body', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK} points={[point(900, 0.9)]}
      basisKey="b" basisWornKey="bw">{(basis) => <p className="basis">{basis}</p>}</MetricCard>))
    expect([...container!.innerHTML.matchAll(/class="basis"/g)]).toHaveLength(1)
  })

  // The other half: a 'header' caller gets the basis on Card and nothing more, even when children
  // renders content of its own.
  it('prints the basis exactly once when placement is header', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="header" query={OK} points={[point(900, 0.9)]}
      basisKey="b" basisWornKey="bw">{() => <span>chart</span>}</MetricCard>))
    expect([...container!.innerHTML.matchAll(/class="basis"/g)]).toHaveLength(1)
  })

  // The fourth reason a chart is empty, and the one MetricCard is now the single place that
  // knows about: emptyState.ts cannot answer 'not_synced' on its own, since it has no way to ask
  // which types a person turned off. useDataTypes() is that missing half.
  it('renders not synced when the metric belongs to a data type the person excluded', () => {
    mount(withQuery(
      <MetricCard metric="steps" span={1} basisPlacement="body" query={OK} points={[point(900, 0.9)]}
        basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>,
      [{ id: 'steps', tier: 'intraday', excluded: true }],
    ))
    expect(container!.textContent).toContain('emptyState.not_synced.title')
    expect(container!.textContent).not.toContain('drawn')
  })

  // Excluding some other data type must not blank a metric this household still syncs.
  it('draws real data when a different data type was excluded', () => {
    mount(withQuery(
      <MetricCard metric="steps" span={1} basisPlacement="body" query={OK} points={[point(900, 0.9)]}
        basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>,
      [{ id: 'weight', tier: 'daily', excluded: true }],
    ))
    expect(container!.textContent).toContain('drawn')
  })

  // The feature. A card whose only job was to show this period, saying it has nothing to show for
  // this period, is a sentence the reader already knows the answer to.
  it('renders nothing at all for a period with no rows', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.querySelectorAll('.card')).toHaveLength(0)
    expect(container!.textContent).toBe('')
  })

  // The cold-load race this gate exists for. useDataTypes answers `items: []` while its own
  // request is still in flight, and an empty exclusion list is indistinguishable from "nothing is
  // excluded" — so a metric the reader HAS turned off reads as no_data for that moment, and
  // no_data hides. One card blinking would be bad enough; the page-level empty state is worse,
  // because on a household that has excluded most of its types every card hides at once and the
  // page says "Nothing recorded here. Try a wider range above", which is advice pointing at the
  // wrong control entirely.
  //
  // Loading, not the drawn card and not nothing: the request that would settle this is in flight,
  // so the honest answer is that nothing is known yet.
  it('keeps the card while the exclusion list is still loading', () => {
    mount(withDataTypesInFlight(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
    expect(container!.textContent).toContain('common.loading')
    expect(container!.textContent).not.toContain('drawn')
  })

  // The other side of that gate, and the reason it is scoped to the vanishing decision rather than
  // applied to every render: a card with data to draw must not be made to wait on the exclusion
  // list. Same in-flight query as the test above, so the only difference is that there are points.
  it('draws data without waiting for the exclusion list', () => {
    mount(withDataTypesInFlight(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK}
      points={[point(900, 0.9)]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.textContent).toContain('drawn')
  })

  // The half that must NOT hide: not_worn names a remedy (wear the device), so it keeps its card.
  // point(0, 0) is a row whose coverage is below NOT_WORN_MAX_COVERAGE, which is what makes this
  // not_worn rather than no_data.
  it('keeps the card for a period where nothing was worn', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK}
      points={[point(0, 0)]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
    expect(container!.textContent).toContain('emptyState.not_worn.title')
  })

  // The other half that must not hide: not_synced is the only state the reader can act on in
  // Settings, and it is the last trace that the data type exists.
  it('keeps the card for a data type the person excluded', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body" query={OK}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>,
      [{ id: 'steps', tier: 'intraday', excluded: true }]))
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
    expect(container!.textContent).toContain('emptyState.not_synced.title')
  })

  // Hiding must not swallow a failure or a request still in flight: both are cards the reader
  // needs, and both reach this component with points: [], the same shape no_data does.
  it('keeps the card for a failed request', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body"
      query={{ isError: true, isPending: false, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
  })

  it('keeps the card while the request is still in flight', () => {
    mount(withQuery(<MetricCard metric="steps" span={1} basisPlacement="body"
      query={{ isError: false, isPending: true, refetch: () => {} }}
      points={[]} basisKey="b" basisWornKey="bw">{() => <span>drawn</span>}</MetricCard>))
    expect(container!.querySelectorAll('.card')).toHaveLength(1)
  })
})
