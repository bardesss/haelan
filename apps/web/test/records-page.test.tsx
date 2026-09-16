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
  records: [], sessionRecords: [], eddington: null, milestones: [],
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
        from: '2026-01-21', days: 235, sourceName: null,
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
        from: '2024-08-25', days: 230, sourceName: null,
      }],
    })
    expect(text("[data-metric='floors'] .record-value")).toBe('42')
  })

  it('says what window the eddington number rests on, when it is not the page’s', () => {
    // The case the archive exhibits: steps start eight months in, so E covers 235 days of 750
    // and must not present as covering the lot.
    mountPage({
      span: { from: '2024-08-25', to: '2026-09-14', days: 750 },
      records: [], sessionRecords: [], milestones: [],
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

  it('renders a distance record in kilometres, not in stored millimetres', () => {
    // METRICS.distance stores millimetres at precision 0, which every other surface converts at
    // the point of display. A raw formatNumber here prints a 10km day as "10,000,000".
    mountPage({
      ...EMPTY,
      records: [{
        metric: 'distance', tier: 'merged', localDate: '2026-03-14', value: 10_000_000,
        from: '2026-01-21', days: 235, sourceName: null,
      }],
    })
    expect(text("[data-metric='distance'] .record-value")).toBe('10.0 km')
  })

  it('formats a million steps as a number a person reads, not as 1000000', () => {
    mountPage({
      ...EMPTY,
      milestones: [{ kind: 'count', metric: 'steps', count: 1_000_000, localDate: '2026-05-05' }],
    })
    expect(text('.milestone-label')).toBe('1,000,000 steps in total')
  })

  it('says how far back a record’s own history goes, not just how many days', () => {
    // Every figure on this page names the window it covers. The record row knew how many days
    // it beat and never said when they started, which for floors is 2024 and for steps 2026.
    mountPage({
      ...EMPTY,
      records: [{
        metric: 'steps', tier: 'merged', localDate: '2026-03-14', value: 21000,
        from: '2026-01-21', days: 235, sourceName: null,
      }],
    })
    const from = new Date('2026-01-21T00:00:00Z').toLocaleString('en', { dateStyle: 'medium' })
    expect(text("[data-metric='steps'] .record-window")).toBe(`of 235 days since ${from}`)
  })

  it('shows the three session records in the units each one is measured in', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'CARDIO_WORKOUT', value: 264 * 60_000 },
        { kind: 'furthest', sessionId: 'b', localDate: '2026-09-12', exerciseType: 'RUNNING', value: 12_850_000 },
        { kind: 'fastest-km', sessionId: 'c', localDate: '2026-06-16', exerciseType: 'RUNNING', value: 308.5 },
      ],
    })
    expect(text("[data-record='longest'] .record-value")).toBe('4h 24m')
    expect(text("[data-record='furthest'] .record-value")).toBe('12.9 km')
    // 308.5s rounds to 5:09, not down to 5:08. A record must never render faster than it was
    // run, so the half-second goes against the runner rather than for them.
    expect(text("[data-record='fastest-km'] .record-value")).toBe('5:09 / km')
  })

  it('shows only the session records the sessions support', () => {
    // A household that only lifts has a longest session and no distance at all. A card reading
    // "furthest: none" would be worse than no card.
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'WORKOUT', value: 60 * 60_000 },
      ],
    })
    expect(container!.querySelectorAll('[data-record]')).toHaveLength(1)
    expect(container!.querySelector("[data-record='furthest']")).toBeNull()
  })

  it('names the device that set a record, and says nothing when it cannot', () => {
    mountPage({
      ...EMPTY,
      records: [
        { metric: 'steps', tier: 'merged', localDate: '2026-03-14', value: 21000, from: '2026-01-21', days: 235, sourceName: 'Pixel Watch 4' },
        { metric: 'floors', tier: 'provider', localDate: '2026-02-02', value: 42, from: '2024-08-25', days: 230, sourceName: null },
      ],
    })
    expect(text("[data-metric='steps'] .record-source")).toBe('Pixel Watch 4')
    expect(container!.querySelector("[data-metric='floors'] .record-source")).toBeNull()
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
    mountPage({ span: { from: '', to: '', days: 0 }, records: [], sessionRecords: [], eddington: null, milestones: [] })
    expect(text('.all-time-empty')).toBe('Nothing on record yet. Sync some history and come back.')
  })
})
