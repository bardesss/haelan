// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { Records } from '../src/pages/Records.js'
import { allTimeKey } from '../src/data/useAllTime.js'
import type { AllTime } from '../src/data/useAllTime.js'
import type { Session } from '../src/auth/session.js'

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
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true,
  credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const EMPTY: AllTime = {
  span: { from: '2026-01-01', to: '2026-01-31', days: 31 },
  records: [], eddington: null, milestones: [],
}

/** The page's own query key pre-seeded: an unseeded query reaches the real network here. */
function mountPage(all: AllTime): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(allTimeKey(PERSON.personId), all)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Records /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const text = (selector: string): string => container!.querySelector(selector)?.textContent ?? ''

describe('the all-time page', () => {
  it('states the span it covers, because an all-time figure owes the reader its window', () => {
    mountPage({ ...EMPTY, span: { from: '2024-08-25', to: '2026-09-14', days: 750 } })
    const from = new Date('2024-08-25T00:00:00Z').toLocaleString('en', { dateStyle: 'medium' })
    const to = new Date('2026-09-14T00:00:00Z').toLocaleString('en', { dateStyle: 'medium' })
    expect(text('.all-time-span')).toBe(`All time: ${from} to ${to}, 750 days`)
  })

  it('renders no control row, because a range picker here would either lie or do nothing', () => {
    mountPage(EMPTY)
    expect(container!.querySelector('.control-row')).toBeNull()
  })

  it('shows each record with the day it was set', () => {
    mountPage({
      ...EMPTY,
      records: [{
        metric: 'steps', tier: 'merged', localDate: '2026-03-14', value: 21000,
        from: '2026-01-21', days: 235,
      }],
    })
    expect(text("[data-metric='steps'] .record-value")).toBe('21,000')
    const expected = new Date('2026-03-14T00:00:00Z').toLocaleString('en', { dateStyle: 'medium' })
    expect(text("[data-metric='steps'] .record-date")).toBe(expected)
  })

  it('shows a record for a metric that lives only in the provider tier', () => {
    // The whole reason the reader looks in two tiers. A page that only ever saw merged rows
    // would render nothing here and look perfectly healthy doing it.
    mountPage({
      ...EMPTY,
      records: [{
        metric: 'floors', tier: 'provider', localDate: '2026-02-02', value: 42,
        from: '2024-08-25', days: 230,
      }],
    })
    expect(text("[data-metric='floors'] .record-value")).toBe('42')
  })

  it('says what window the eddington number rests on, when it is not the page’s', () => {
    // The case the archive exhibits: steps start eight months in, so E covers 235 days of 750
    // and must not present as covering the lot.
    mountPage({
      span: { from: '2024-08-25', to: '2026-09-14', days: 750 },
      records: [], milestones: [],
      eddington: { e: 13, from: '2026-01-21', days: 235 },
    })
    expect(text('.eddington-value')).toBe('13')
    const from = new Date('2026-01-21T00:00:00Z').toLocaleString('en', { dateStyle: 'medium' })
    expect(text('.eddington-window')).toBe(`Over 235 days with a step count, from ${from}.`)
  })

  it('says nothing about an eddington number it has no steps for', () => {
    mountPage({ ...EMPTY, eddington: null })
    expect(container!.querySelector('.eddington-value')).toBeNull()
  })

  it('calls a first "first recorded", because it marks when syncing began', () => {
    mountPage({ ...EMPTY, milestones: [{ kind: 'first', metric: 'exercise', localDate: '2026-01-27' }] })
    expect(text("[data-kind='first']")).toContain('First recorded workout')
  })

  it('renders no run milestone when the reader withheld one', () => {
    // Below MIN_RUN_DAYS the reader answers no run at all, and the page must not invent a row
    // saying "longest run: none" - which would be the criticism the withholding exists to avoid.
    mountPage({ ...EMPTY, milestones: [{ kind: 'first', metric: 'sleep', localDate: '2026-01-24' }] })
    expect(container!.querySelector("[data-kind='run']")).toBeNull()
    expect(container!.querySelectorAll('.milestone')).toHaveLength(1)
  })

  it('says the archive is empty rather than rendering blank sections', () => {
    mountPage({ span: { from: '', to: '', days: 0 }, records: [], eddington: null, milestones: [] })
    expect(text('.all-time-empty')).toBe('Nothing on record yet. Sync some history and come back.')
  })
})
