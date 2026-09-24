// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { MetricCard } from '../src/components/MetricCard.js'
import { StatTile } from '../src/components/StatTile.js'
import { StaleSourcesProvider } from '../src/data/staleSources.js'
import type { SeriesPoint } from '../src/data/useSeries.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { dataTypesKey } from '../src/data/useDataTypes.js'
import { sourceActivityKey } from '../src/data/useSourceNames.js'
import type { NamedSourceWithActivity } from '../src/data/useSourceNames.js'

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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function source(id: string, name: string, over: Partial<NamedSourceWithActivity> = {}): NamedSourceWithActivity {
  return {
    id, name, kind: 'device', createdAtMs: 0,
    lastReportedDate: '2026-08-12', reportingDates: 90, medianGapDays: 1, status: 'stale', reportingNow: false,
    ...over,
  } as NamedSourceWithActivity
}

// Seeded, never fetched: the activity query sits under the settings card's own key, so seeding it
// here is also what proves the provider shares that cache rather than asking a second time.
function tree(node: ReactNode, sources: NamedSourceWithActivity[], lng = 'en'): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(dataTypesKey(PERSON.personId), { items: [] })
  client.setQueryData(sourceActivityKey(PERSON.personId), { items: sources })
  return <QueryClientProvider client={client}><I18nProvider lng={lng}>{node}</I18nProvider></QueryClientProvider>
}

const mix = (...sources: string[]) => JSON.stringify(sources.map((s) => ({ source: s, share: 1 / sources.length })))

function points(sourceMix: string | null, source = 'merged'): SeriesPoint[] {
  return ['2026-08-01', '2026-08-02', '2026-08-03'].map((localDate) => ({
    localDate, value: 8000, coverage: 1, source, sourceMix, updatedAtMs: 0, filled: false,
  }))
}

const OK = { isError: false, isPending: false, refetch: () => {} }

// The basis keys are activity.distance's because the dashboard.steps pair these cards used to borrow
// left with the old Dashboard in M9b; distance's two templates have the same shape and placeholders.
function card(pts: SeriesPoint[], label: string | undefined = 'Steps'): ReactNode {
  return (
    <MetricCard metric="steps" query={OK} points={pts} span={4} label={label} basisPlacement="header"
      basisKey="activity.distance.basis" basisWornKey="activity.distance.basisWorn" basisValues={{ total: 31 }}>
      {() => <p>chart</p>}
    </MetricCard>
  )
}

function tile(pts: SeriesPoint[]): ReactNode {
  return (
    <MetricCard metric="steps" query={OK} points={pts} span={4} basisPlacement="body"
      basisKey="activity.distance.basis" basisWornKey="activity.distance.basisWorn" basisValues={{ total: 31 }}>
      {(basis) => <StatTile label="Steps" value="24,000" basis={basis} />}
    </MetricCard>
  )
}

const warnings = () => [...container!.querySelectorAll('.source-warning')]

describe('the stale source warning', () => {
  it('marks a card whose source went quiet inside the range on screen, beside its title', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{card(points(mix('watch', 'phone')))}</StaleSourcesProvider>,
      [source('watch', 'My watch'), source('phone', 'Phone', { status: 'reporting', reportingNow: true, lastReportedDate: '2026-08-31' })])) })
    expect(warnings()).toHaveLength(1)
    const warning = warnings()[0]!
    expect(warning.closest('.label')?.textContent).toContain('Steps')
    expect(warning.getAttribute('title')).toBe('My watch has not reported since Aug 12, 2026; it usually reports daily.')
    expect(warning.querySelector('.sr-only')?.textContent).toBe(warning.getAttribute('title'))
  })

  // Looking back at a range that ended before the source went quiet: the source was fine then.
  it('says nothing about a range that ended before the source stopped', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-07-31">{card(points(mix('watch')))}</StaleSourcesProvider>,
      [source('watch', 'My watch')])) })
    expect(warnings()).toHaveLength(0)
  })

  it('says nothing for a source that is still reporting, or one too new to judge', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{card(points(mix('watch', 'scale')))}</StaleSourcesProvider>, [
      source('watch', 'My watch', { status: 'reporting', reportingNow: true }),
      source('scale', 'Scale', { status: 'unjudged', medianGapDays: null }),
    ])) })
    expect(warnings()).toHaveLength(0)
  })

  it('says nothing about a stale source that does not feed this card', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{card(points(mix('phone')))}</StaleSourcesProvider>,
      [source('watch', 'My watch')])) })
    expect(warnings()).toHaveLength(0)
  })

  it('reads the device itself when the reader picked one, where a point carries no mix', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{card(points(null, 'watch'))}</StaleSourcesProvider>,
      [source('watch', 'My watch')])) })
    expect(warnings()).toHaveLength(1)
  })

  it('draws the mark once on a tile card, beside the title the tile prints', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{tile(points(mix('watch')))}</StaleSourcesProvider>,
      [source('watch', 'My watch')])) })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]!.closest('header')).not.toBeNull()
  })

  it('names a source that reports less often by its own cadence, and says every stale source', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{card(points(mix('watch', 'scale')))}</StaleSourcesProvider>, [
      source('watch', 'My watch'),
      source('scale', 'Scale', { lastReportedDate: '2026-06-01', medianGapDays: 7.4 }),
    ])) })
    expect(warnings()[0]!.getAttribute('title')).toBe(
      'My watch has not reported since Aug 12, 2026; it usually reports daily. '
      + 'Scale has not reported since Jun 1, 2026; it usually reports every 7 days.')
  })

  it('says it in Dutch', () => {
    act(() => { root!.render(tree(<StaleSourcesProvider rangeEnd="2026-08-31">{card(points(mix('watch')))}</StaleSourcesProvider>,
      [source('watch', 'Mijn horloge')], 'nl')) })
    expect(warnings()[0]!.getAttribute('title')).toBe('Mijn horloge heeft sinds 12 aug 2026 niets meer doorgegeven; normaal gebeurt dat dagelijks.')
  })

  // Every card outside a page that adopted this, and every existing test, renders as before.
  it('draws nothing outside a provider', () => {
    act(() => { root!.render(tree(card(points(mix('watch'))), [source('watch', 'My watch')])) })
    expect(container!.textContent).toContain('chart')
    expect(warnings()).toHaveLength(0)
  })
})
