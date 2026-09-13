// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { Night } from '../src/data/useNights.js'
import { NightList } from '../src/pages/sleep/NightList.js'
import { nightPath } from '../src/pages/sleep/NightRow.js'
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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

const CONTROLS = {
  tab: 'month' as const, anchor: '2026-08-15', source: ALL_SOURCES,
  from: '2026-08-01', to: '2026-08-31', historicalTo: '2026-08-31',
  setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
}

const NIGHTS_KEY = queryKeys.resource('p1', 'sleep-nights', {
  from: CONTROLS.from, to: CONTROLS.to, source: CONTROLS.source,
})

const night = (localDate: string, sourceId: string, hours: number, over: Partial<Night> = {}): Night => ({
  localDate, sourceId, sessionIds: [`${sourceId}-${localDate}`],
  startMs: Date.UTC(2026, 7, 2, 21, 0), endMs: Date.UTC(2026, 7, 2, 21, 0) + hours * 3_600_000,
  startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], segments: [], excludedSessions: [],
  ...over,
})

function clientWith(items: Night[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(NIGHTS_KEY, { items, cursor: null })
  client.setQueryData(queryKeys.resource('p1', 'sources'), { items: [] })
  return client
}

function mount(client: QueryClient, node: ReactNode): void {
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">{node}</I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const html = () => container?.innerHTML ?? ''

describe('the night list', () => {
  it('links each night to its own page, by date', () => {
    mount(clientWith([night('2026-08-03', 'watch', 8)]), <NightList controls={CONTROLS} />)
    // nightPath itself, not a hand written literal: NightRow.tsx's own comment on it claims this
    // spelling is "shared by the row that links there and the tests that assert it", which was
    // false until this import made it true.
    expect(container?.querySelector('a')?.getAttribute('href')).toBe(nightPath('2026-08-03'))
  })

  it('shows one row per date even when two sources reported the same night', () => {
    // Same rule the hypnogram above it already applies: the longer recording wins.
    mount(clientWith([night('2026-08-03', 'watch', 8), night('2026-08-03', 'phone', 3)]),
      <NightList controls={CONTROLS} />)
    expect(container?.querySelectorAll('.night-row')).toHaveLength(1)
  })

  it('counts the nights it is showing', () => {
    mount(clientWith([night('2026-08-03', 'watch', 8), night('2026-08-04', 'watch', 7)]),
      <NightList controls={CONTROLS} />)
    expect(container?.querySelector('.night-list-count')?.textContent).toBe('2 recorded nights in this period')
  })

  it('says the period holds no nights rather than rendering an empty list', () => {
    mount(clientWith([]), <NightList controls={CONTROLS} />)
    expect(container?.querySelectorAll('.night-row')).toHaveLength(0)
    expect(html()).toContain('No nights in this period')
  })

  // Renamed from "... and its time asleep": '8h 00m' here is the night's own span (endMs - startMs,
  // bed to wake), not a derived time-asleep figure - NightRow.tsx's own comment says time asleep is
  // deliberately not shown on this row at all, since the list has no /series request of its own to
  // read it from. The old title asserted a claim this row does not make.
  it('names each night\'s source and its time in bed', () => {
    mount(clientWith([night('2026-08-03', 'watch', 8)]), <NightList controls={CONTROLS} />)
    // nameOf falls back to the id when no alias is known, which is what an empty sources list means.
    const row = container?.querySelector('.night-row')?.textContent ?? ''
    expect(row).toContain('watch')
    expect(row).toContain('8h 00m')
  })

  // Task 2 review: nothing exercised night-row-excluded, the branch that says a session was thrown
  // out of this night, so a broken or removed rendering of it would have shipped unnoticed. The
  // whole sentence, not a substring, for the same reason the plural form below matters: a dropped
  // pluralisation ("2 session excluded") still contains "excluded" and "2".
  it('says a session was excluded from a night that has one', () => {
    mount(clientWith([night('2026-08-03', 'watch', 8, { excludedSessions: ['s1'] })]),
      <NightList controls={CONTROLS} />)
    expect(container?.querySelector('.night-row-excluded')?.textContent).toBe('1 session excluded')
  })

  it('pluralises when a night has more than one excluded session', () => {
    mount(clientWith([night('2026-08-03', 'watch', 8, { excludedSessions: ['s1', 's2'] })]),
      <NightList controls={CONTROLS} />)
    expect(container?.querySelector('.night-row-excluded')?.textContent).toBe('2 sessions excluded')
  })

  // The other side of both cases above: a night with nothing excluded renders no such line at all,
  // rather than one reading "0 sessions excluded" - the same "absent, never empty" rule the empty
  // list state above this one follows.
  it('renders no excluded line for a night that excluded nothing', () => {
    mount(clientWith([night('2026-08-03', 'watch', 8)]), <NightList controls={CONTROLS} />)
    expect(container?.querySelector('.night-row-excluded')).toBeNull()
  })
})
