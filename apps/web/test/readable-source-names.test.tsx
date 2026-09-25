// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider, initI18n } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SourceNames } from '../src/pages/settings/SourceNames.js'
import { StatusPanel } from '../src/components/StatusPanel.js'
import type { StatusPanel as StatusPanelData } from '../src/data/useStatusPanel.js'
import { sourceActivityKey, sourceLabel, sourceNamesKey, useSourceNames } from '../src/data/useSourceNames.js'
import type { NamedSourceWithActivity } from '../src/data/useSourceNames.js'
import { sourcePriorityKey } from '../src/data/useSourcePriority.js'

// A known app's default name is resolved by the server in English (NamedSource.name) and said
// again here in the reader's language from `defaultName`. Synthetic sources only: the package
// names are the real ones the server keys on, everything else is made up.

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// This year, so the date is said without one - the rule sourceLabel shares with the panel's days.
const YEAR = new Date().getUTCFullYear()
const SEP_4 = `${YEAR}-09-04`
const LAST_YEAR_DEC_31 = `${YEAR - 1}-12-31`

function source(over: Partial<NamedSourceWithActivity> & { id: string, displayName: string, name: string }): NamedSourceWithActivity {
  return {
    externalId: `HEALTH_CONNECT:${over.displayName}`, alias: null, kind: 'app', createdAtMs: 0,
    defaultName: null, lastReportedDate: `${YEAR}-09-20`, reportingDates: 10, medianGapDays: 1,
    status: 'reporting', reportingNow: true, continuedElsewhere: false, panelChoice: true,
    ...over,
  }
}

const SOURCES: NamedSourceWithActivity[] = [
  source({
    id: 'haelan', displayName: 'com.haelan.android', name: 'Haelan (phone)',
    defaultName: { key: 'haelanPhone', since: null, tag: null },
  }),
  source({
    id: 'hc', displayName: 'com.android.healthconnect.phone.0a1b2c3d', name: `Health Connect (phone), since 4 Sep ${YEAR}`,
    defaultName: { key: 'healthConnectPhone', since: SEP_4, tag: null },
  }),
  source({
    id: 'renamed', displayName: 'health.openscale.sync.oss', name: 'Bathroom scale', alias: 'Bathroom scale',
    defaultName: { key: 'openScale', since: null, tag: null },
  }),
  source({ id: 'lyfta', displayName: 'com.lyfta', name: 'com.lyfta' }),
]

describe('sourceLabel', () => {
  const en = initI18n('en').t
  const nl = initI18n('nl').t

  it('says a known app in the reader\'s language', () => {
    expect(sourceLabel(SOURCES[0]!, en, 'en')).toBe('Haelan (phone)')
    expect(sourceLabel(SOURCES[0]!, nl, 'nl')).toBe('Haelan (telefoon)')
  })

  it('dates a disambiguated default in the reader\'s locale, with the year only when it is another', () => {
    expect(sourceLabel(SOURCES[1]!, en, 'en')).toBe('Health Connect (phone), since Sep 4')
    expect(sourceLabel(SOURCES[1]!, nl, 'nl')).toBe('Health Connect (telefoon), sinds 4 sep')
    const older = { name: 'x', defaultName: { key: 'healthConnectPhone', since: LAST_YEAR_DEC_31, tag: 'aaaa' } }
    expect(sourceLabel(older, en, 'en')).toBe(`Health Connect (phone), since Dec 31, ${YEAR - 1} (aaaa)`)
  })

  it('lets an alias win over the default', () => {
    expect(sourceLabel(SOURCES[2]!, nl, 'nl')).toBe('Bathroom scale')
  })

  it('prints the server\'s name for an unknown app, and for a key this catalogue lacks', () => {
    expect(sourceLabel(SOURCES[3]!, nl, 'nl')).toBe('com.lyfta')
    expect(sourceLabel({ name: 'Newer app', defaultName: { key: 'notYetKnown', since: null, tag: null } }, nl, 'nl'))
      .toBe('Newer app')
  })
})

describe('the Settings source list', () => {
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

  function mount(lng: string): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    client.setQueryData(sourceActivityKey(PERSON.personId), { items: SOURCES })
    client.setQueryData(sourcePriorityKey(PERSON.personId), {
      configured: false, order: SOURCES.map((s) => ({ sourceId: s.id, configured: false })),
    })
    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nProvider lng={lng}><SourceNames /></I18nProvider>
        </QueryClientProvider>,
      )
    })
  }

  const placeholders = (): string[] =>
    [...container!.querySelectorAll('input[type="text"]')].map((i) => i.getAttribute('placeholder') ?? '')
  const details = (): string[] =>
    [...container!.querySelectorAll('.source-name-detail')].map((e) => e.textContent ?? '')
  const orderHeadings = (): string[] =>
    [...container!.querySelectorAll('.source-order-list h4')].map((e) => e.textContent ?? '')

  it('shows the readable default as the placeholder, and keeps the raw id in the detail line (en)', () => {
    mount('en')
    // The renamed source's placeholder is what it goes back to being called, not its alias.
    expect(placeholders()).toEqual(['Haelan (phone)', 'Health Connect (phone), since Sep 4', 'openScale', 'com.lyfta'])
    expect(details()).toEqual([
      'com.haelan.android - haelan',
      'com.android.healthconnect.phone.0a1b2c3d - hc',
      'health.openscale.sync.oss - renamed',
      'com.lyfta - lyfta',
    ])
    expect(orderHeadings()).toEqual(['Haelan (phone)', 'Health Connect (phone), since Sep 4', 'Bathroom scale', 'com.lyfta'])
  })

  it('says the same defaults in Dutch (nl)', () => {
    mount('nl')
    expect(placeholders()).toEqual(['Haelan (telefoon)', 'Health Connect (telefoon), sinds 4 sep', 'openScale', 'com.lyfta'])
    expect(orderHeadings()).toEqual(['Haelan (telefoon)', 'Health Connect (telefoon), sinds 4 sep', 'Bathroom scale', 'com.lyfta'])
  })
})

describe('the status panel', () => {
  const STATUS: StatusPanelData = {
    connections: [{
      kind: 'phone', lastDeliveryAtMs: Date.now() - 60_000, problem: null,
      devices: [
        { sourceId: 'haelan', name: 'Haelan (phone)', defaultName: { key: 'haelanPhone', since: null, tag: null }, lastReportedDate: `${YEAR}-09-20`, stale: false, choice: null, metrics: [] },
        { sourceId: 'hc', name: 'x', defaultName: { key: 'healthConnectPhone', since: SEP_4, tag: null }, lastReportedDate: `${YEAR}-09-20`, stale: false, choice: null, metrics: [] },
        // What the server sends for a renamed source: the alias as `name`, and no default.
        { sourceId: 'renamed', name: 'Bathroom scale', defaultName: null, lastReportedDate: `${YEAR}-09-20`, stale: false, choice: null, metrics: [] },
      ],
    }],
    sync: null, problems: 0, hiddenDevices: 0,
  }

  const rowNames = (lng: string): string[] => {
    const html = renderToStaticMarkup(
      <I18nProvider lng={lng}>
        <StatusPanel status={STATUS} today={`${YEAR}-09-25`} syncPending={false} outcome={null} onSync={() => {}} />
      </I18nProvider>,
    )
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return [...doc.querySelectorAll('.status-device > span:first-child')].map((e) => e.textContent ?? '')
  }

  it('names each device readably in English', () => {
    expect(rowNames('en')).toEqual(['Haelan (phone)', 'Health Connect (phone), since Sep 4', 'Bathroom scale'])
  })

  it('and in Dutch', () => {
    expect(rowNames('nl')).toEqual(['Haelan (telefoon)', 'Health Connect (telefoon), sinds 4 sep', 'Bathroom scale'])
  })
})

// nameOf backs every picker, chart legend and heading outside Settings, so it has to say the
// default in the reader's language as well, not only the Settings card.
describe('useSourceNames().nameOf', () => {
  function Names() {
    const { nameOf } = useSourceNames()
    return <ul>{SOURCES.map((s) => <li key={s.id}>{nameOf(s.id)}</li>)}</ul>
  }

  const render = (lng: string): string[] => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    client.setQueryData(sourceNamesKey(PERSON.personId), { items: SOURCES })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider lng={lng}><Names /></I18nProvider>
      </QueryClientProvider>,
    )
    return [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('li')].map((e) => e.textContent ?? '')
  }

  it('names each source in Dutch', () => {
    expect(render('nl')).toEqual(['Haelan (telefoon)', 'Health Connect (telefoon), sinds 4 sep', 'Bathroom scale', 'com.lyfta'])
  })
})
