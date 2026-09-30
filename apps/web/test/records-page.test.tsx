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
  timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true,
  credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const EMPTY: AllTime = {
  span: { from: '2026-01-01', to: '2026-01-31', days: 31 },
  records: [], sessionRecords: [], eddington: null, milestones: [],
}

/** The page's own query key pre-seeded: an unseeded query reaches the real network here. */
function mountPage(all: AllTime, lng = 'en'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(allTimeKey(PERSON.personId), all)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng={lng}><Records /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const NB = '\u00a0'
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
    // A day's distance, as the Activity page prints one, with a no-break space like every figure beside it.
    expect(text("[data-metric='distance'] .record-value")).toBe('10.0\u00a0km')
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

  it('shows the session records in the units each one is measured in', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'furthest', sessionId: 'b', localDate: '2026-09-12', exerciseType: 'RUNNING', value: 12_850 },
        { category: 'run', kind: 'fastest-1k', sessionId: 'c', localDate: '2026-06-16', exerciseType: 'RUNNING', value: 308.5 },
        { category: 'cardio', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'CARDIO_WORKOUT', value: 264 * 60_000 },
      ],
    })
    expect(text("[data-record='longest'] .record-metric")).toBe('Longest')
    expect(text("[data-record='longest'] .record-value")).toBe(`4h${NB}24m`)
    expect(text("[data-record='furthest'] .record-metric")).toBe('Furthest')
    // Whole metres, read as the workout page reads a distance.
    expect(text("[data-record='furthest'] .record-value")).toBe(`12.9${NB}km`)
    // 308.5s rounds to 5:09, not down to 5:08. A record must never render faster than it was
    // run, so the half-second goes against the runner rather than for them.
    expect(text("[data-record='fastest-1k'] .record-value")).toBe(`5:09${NB}/km`)
  })

  it('shows the fastest mile and 5 km off the GPS route as a stopwatch time with its pace', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'fastest-mile', sessionId: 'd', localDate: '2026-05-20', exerciseType: 'RUNNING', value: 466 },
        { category: 'run', kind: 'fastest-5k', sessionId: 'e', localDate: '2026-08-02', exerciseType: 'RUNNING', value: 3662 },
      ],
    })
    expect(text("[data-record='fastest-mile'] .record-metric")).toBe('Fastest mile')
    // 466 s over 1.609 km is 289.6 s a km.
    expect(text("[data-record='fastest-mile'] .record-value")).toBe(`7:46 · 4:50${NB}/km`)
    expect(text("[data-record='fastest-5k'] .record-metric")).toBe('Fastest 5 km')
    // Past the hour, the stopwatch shows one.
    expect(text("[data-record='fastest-5k'] .record-value")).toBe(`1:01:02 · 12:12${NB}/km`)
  })

  it('names the fastest mile and 5 km in Dutch', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'fastest-mile', sessionId: 'd', localDate: '2026-05-20', exerciseType: 'RUNNING', value: 466 },
        { category: 'run', kind: 'fastest-5k', sessionId: 'e', localDate: '2026-08-02', exerciseType: 'RUNNING', value: 1562 },
      ],
    }, 'nl')
    expect(text("[data-record='fastest-mile'] .record-metric")).toBe('Snelste mijl')
    expect(text("[data-record='fastest-mile'] .record-value")).toBe(`7:46 · 4:50${NB}/km`)
    expect(text("[data-record='fastest-5k'] .record-metric")).toBe('Snelste 5 km')
    expect(text("[data-record='fastest-5k'] .record-value")).toBe(`26:02 · 5:12${NB}/km`)
  })

  it('writes the longest session\'s hour as "u" in Dutch', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'cardio', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'CARDIO_WORKOUT', value: 264 * 60_000 },
      ],
    }, 'nl')
    expect(text("[data-record='longest'] .record-value")).toBe(`4u${NB}24m`)
  })

  it('shows only the session records the sessions support', () => {
    // A household that only lifts has a longest session and no distance at all. A card reading
    // "furthest: none" would be worse than no card.
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'cardio', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'WORKOUT', value: 60 * 60_000 },
      ],
    })
    expect(container!.querySelectorAll('[data-record]')).toHaveLength(1)
    expect(container!.querySelector("[data-record='furthest']")).toBeNull()
  })

  it('lists each category its own rows, a longest for each, labelled per kind', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'TRAIL_RUN', value: 95 * 60_000 },
        { category: 'run', kind: 'most-climb', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'TRAIL_RUN', value: 412 },
        { category: 'run', kind: 'fastest-10k', sessionId: 'b', localDate: '2026-07-01', exerciseType: 'RUNNING', value: 2890 },
        { category: 'ride', kind: 'longest', sessionId: 'c', localDate: '2026-08-02', exerciseType: 'BIKING', value: 180 * 60_000 },
        { category: 'ride', kind: 'fastest-20k', sessionId: 'c', localDate: '2026-08-02', exerciseType: 'BIKING', value: 2400 },
      ],
    })
    expect(container!.querySelectorAll("[data-record='longest']")).toHaveLength(2)
    expect(text("[data-category='run'][data-record='longest'] .record-metric")).toBe('Longest')
    expect(text("[data-category='ride'][data-record='longest'] .record-metric")).toBe('Longest')
    expect(text("[data-category='ride'][data-record='longest'] .record-value")).toBe(`3h${NB}00m`)
    expect(text("[data-record='most-climb'] .record-metric")).toBe('Most climb')
    expect(text("[data-record='most-climb'] .record-value")).toBe(`412${NB}m`)
    expect(text("[data-record='fastest-10k'] .record-metric")).toBe('Fastest 10 km')
    // 2890 s over 10 km is 4:49 a km.
    expect(text("[data-record='fastest-10k'] .record-value")).toBe(`48:10 · 4:49${NB}/km`)
    expect(text("[data-record='fastest-20k'] .record-metric")).toBe('Fastest 20 km')
    // A ride reads its speed: 20 km in 40 minutes is 30 km/h.
    expect(text("[data-record='fastest-20k'] .record-value")).toBe(`40:00 · 30.0${NB}km/h`)
  })

  it('names the new kinds in Dutch, a ride in km/u', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'walk', kind: 'most-climb', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'HIKING', value: 1250 },
        { category: 'run', kind: 'fastest-half', sessionId: 'b', localDate: '2026-07-01', exerciseType: 'RUNNING', value: 6300 },
        { category: 'ride', kind: 'fastest-40k', sessionId: 'c', localDate: '2026-08-02', exerciseType: 'BIKING', value: 4800 },
      ],
    }, 'nl')
    expect(text("[data-record='most-climb'] .record-metric")).toBe('Meeste klim')
    // A climb stays in metres past a thousand of them.
    expect(text("[data-record='most-climb'] .record-value")).toBe(`1.250${NB}m`)
    expect(text("[data-record='fastest-half'] .record-metric")).toBe('Snelste halve marathon')
    expect(text("[data-record='fastest-40k'] .record-metric")).toBe('Snelste 40 km')
    expect(text("[data-record='fastest-40k'] .record-value")).toBe(`1:20:00 · 30,0${NB}km/u`)
  })

  it('names the longest and furthest in the same words in every category, in Dutch', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
        { category: 'run', kind: 'furthest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 12_000 },
        { category: 'ride', kind: 'longest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'BIKING', value: 60 * 60_000 },
        { category: 'ride', kind: 'furthest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'BIKING', value: 52_300 },
        { category: 'walk', kind: 'longest', sessionId: 'c', localDate: '2026-06-19', exerciseType: 'WALKING', value: 60 * 60_000 },
        { category: 'walk', kind: 'furthest', sessionId: 'c', localDate: '2026-06-19', exerciseType: 'WALKING', value: 800 },
        { category: 'swim', kind: 'longest', sessionId: 'd', localDate: '2026-06-19', exerciseType: 'SWIMMING_POOL', value: 60 * 60_000 },
        { category: 'swim', kind: 'furthest', sessionId: 'd', localDate: '2026-06-19', exerciseType: 'SWIMMING_POOL', value: 1500 },
        { category: 'strength', kind: 'longest', sessionId: 'e', localDate: '2026-06-19', exerciseType: 'WEIGHTLIFTING', value: 60 * 60_000 },
      ],
    }, 'nl')
    const names = [...container!.querySelectorAll('[data-record] .record-metric')].map((cell) => cell.textContent)
    // The card's label names the sport, so the row does not say it again.
    expect(names).toEqual([
      'Langste', 'Verste', 'Langste', 'Verste', 'Langste', 'Verste', 'Langste', 'Verste', 'Langste',
    ])
    expect(text("[data-category='ride'][data-record='furthest'] .record-value")).toBe(`52,3${NB}km`)
    // Under a kilometre a distance reads in metres; a swim's always does.
    expect(text("[data-category='walk'][data-record='furthest'] .record-value")).toBe(`800${NB}m`)
    expect(text("[data-category='swim'][data-record='furthest'] .record-value")).toBe(`1.500${NB}m`)
  })

  it('gives each category with a record its own card, labelled with its name and icon, run, ride, walk, swim first', () => {
    // Sent out of order on purpose: the page orders the cards itself.
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'other', kind: 'longest', sessionId: 'o', localDate: '2026-06-19', exerciseType: 'SPORT', value: 60 * 60_000 },
        { category: 'swim', kind: 'longest', sessionId: 's', localDate: '2026-06-19', exerciseType: 'SWIMMING_POOL', value: 60 * 60_000 },
        { category: 'cardio', kind: 'longest', sessionId: 'c', localDate: '2026-06-19', exerciseType: 'WORKOUT', value: 60 * 60_000 },
        { category: 'walk', kind: 'longest', sessionId: 'w', localDate: '2026-06-19', exerciseType: 'WALKING', value: 60 * 60_000 },
        { category: 'strength', kind: 'longest', sessionId: 'k', localDate: '2026-06-19', exerciseType: 'WEIGHTLIFTING', value: 60 * 60_000 },
        { category: 'ride', kind: 'longest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'BIKING', value: 60 * 60_000 },
        { category: 'run', kind: 'longest', sessionId: 'r', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
      ],
    })
    const cards = [...container!.querySelectorAll<HTMLElement>('section.card')].filter((card) => card.querySelector('[data-record]') !== null)
    expect(cards.map((card) => card.querySelector('h2.label')?.textContent)).toEqual(
      ['Running', 'Cycling', 'Walking', 'Swimming', 'Strength', 'Cardio', 'Other'])
    expect(cards.map((card) => card.querySelector('h2.label .card-label-icon')?.getAttribute('data-category')))
      .toEqual(['run', 'ride', 'walk', 'swim', 'strength', 'cardio', 'other'])
    // The glyph each category draws (CATEGORY_ICONS), the same one a session row carries.
    for (const card of cards) expect(card.querySelector('h2.label .card-label-icon svg')).not.toBeNull()
    // Each card holds only its own category's rows.
    expect(cards.map((card) => [...card.querySelectorAll('[data-record]')].map((row) => row.getAttribute('data-category'))))
      .toEqual([['run'], ['ride'], ['walk'], ['swim'], ['strength'], ['cardio'], ['other']])
    // Halves, two to a row; the seventh, alone in its row, takes the whole of it.
    expect(cards.map((card) => card.getAttribute('data-span'))).toEqual(['6', '6', '6', '6', '6', '6', '12'])
  })

  // An odd count's last card has no partner: at half width it would share a row with the
  // Eddington card and leave milestones alone below. Full width, the category cards end on a whole
  // row and the two span-6 cards after them pair as before.
  it('gives the last of an odd number of category cards the whole row, so Eddington and milestones still pair', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'r', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
        { category: 'walk', kind: 'longest', sessionId: 'w', localDate: '2026-06-19', exerciseType: 'WALKING', value: 60 * 60_000 },
        { category: 'strength', kind: 'longest', sessionId: 'k', localDate: '2026-06-19', exerciseType: 'WEIGHTLIFTING', value: 60 * 60_000 },
      ],
      eddington: { e: 12, from: '2026-01-01', days: 31 },
      milestones: [{ kind: 'first', metric: 'exercise', localDate: '2026-01-02' }],
    })
    const spans = [...container!.querySelectorAll('section.card')].map((card) => [
      card.querySelector('.record-list[data-category]')?.getAttribute('data-category') ?? card.querySelector('h2.label')?.textContent,
      card.getAttribute('data-span'),
    ])
    expect(spans).toEqual([['run', '6'], ['walk', '6'], ['strength', '12'], ['Eddington number', '6'], ['Milestones', '6']])
  })

  it('names the cards in Dutch', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'r', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
        { category: 'swim', kind: 'longest', sessionId: 's', localDate: '2026-06-19', exerciseType: 'SWIMMING_POOL', value: 60 * 60_000 },
        { category: 'strength', kind: 'longest', sessionId: 'k', localDate: '2026-06-19', exerciseType: 'WEIGHTLIFTING', value: 60 * 60_000 },
        { category: 'other', kind: 'longest', sessionId: 'o', localDate: '2026-06-19', exerciseType: 'SPORT', value: 60 * 60_000 },
      ],
    }, 'nl')
    const labels = [...container!.querySelectorAll('section.card')].filter((card) => card.querySelector('[data-record]') !== null)
      .map((card) => card.querySelector('h2.label')?.textContent)
    expect(labels).toEqual(['Hardlopen', 'Zwemmen', 'Kracht', 'Overig'])
  })

  it('keeps an even number of category cards at half width, the last one too', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'r', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
        { category: 'ride', kind: 'longest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'BIKING', value: 60 * 60_000 },
      ],
    })
    const spans = [...container!.querySelectorAll('.record-list[data-category]')].map((list) => list.closest('section.card')!.getAttribute('data-span'))
    expect(spans).toEqual(['6', '6'])
  })

  it('gives a lone category card the whole row', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'ride', kind: 'longest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'BIKING', value: 60 * 60_000 },
        { category: 'ride', kind: 'furthest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'BIKING', value: 40_000 },
      ],
    })
    const card = container!.querySelector('[data-record]')!.closest('section.card')!
    expect(card.getAttribute('data-span')).toBe('12')
  })

  it('links each row to the workout that set it, the whole row the link', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'run 1', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
        { category: 'ride', kind: 'fastest-20k', sessionId: 'ride-7', localDate: '2026-06-19', exerciseType: 'BIKING', value: 2400 },
      ],
    })
    const links = [...container!.querySelectorAll('[data-record] > a.record-row-link')]
    // Through workoutPath, its id encoded.
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/activity/run%201', '/activity/ride-7'])
    // The row's four cells are inside the link.
    expect(links.map((link) => link.children.length)).toEqual([4, 4])
  })

  it('names the exercise type only where it says more than the card does', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'TREADMILL', value: 95 * 60_000 },
        { category: 'run', kind: 'furthest', sessionId: 'b', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 12_000 },
        { category: 'run', kind: 'most-climb', sessionId: 'c', localDate: '2026-06-19', exerciseType: 'TRAIL_RUN', value: 400 },
        { category: 'cardio', kind: 'longest', sessionId: 'd', localDate: '2026-06-19', exerciseType: 'CARDIO_WORKOUT', value: 60 * 60_000 },
      ],
    }, 'nl')
    expect(text("[data-category='run'][data-record='longest'] .record-source")).toBe('Loopband')
    expect(text("[data-category='run'][data-record='furthest'] .record-source")).toBe('')
    // Seeded since the demo holds one, so in Dutch rather than the humanised English.
    expect(text("[data-category='run'][data-record='most-climb'] .record-source")).toBe('Trailrun')
    // A category with no one plain type names every type.
    expect(text("[data-category='cardio'][data-record='longest'] .record-source")).toBe('Cardiotraining')
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
    expect(text("[data-metric='floors'] .record-source")).toBe('')
  })

  // The server names a known app in English; the key beside it lets the page say it in Dutch.
  it('says a known app\'s default name in the reader\'s language', () => {
    mountPage({
      ...EMPTY,
      records: [{
        metric: 'steps', tier: 'merged', localDate: '2026-03-14', value: 21000, from: '2026-01-21', days: 235,
        sourceName: 'Haelan (phone)', sourceDefaultName: { key: 'haelanPhone', since: null, tag: null },
      }],
    }, 'nl')
    expect(text("[data-metric='steps'] .record-source")).toBe('Haelan (telefoon)')
  })

  // The cell used to be omitted outright, which is what made the rows look misaligned: in a row of
  // columns an absent cell reserves nothing, so the window text on the two metrics that have no
  // single device slid left past every other row's. It is rendered empty instead - still saying
  // nothing, which is the rule a merged day needs (it belongs to no one device, and "unknown"
  // would read as a fault), while holding the column its neighbours are aligned against.
  it('holds the device column even for a metric no single device can be credited with', () => {
    mountPage({
      ...EMPTY,
      records: [
        { metric: 'steps', tier: 'merged', localDate: '2026-03-14', value: 21000, from: '2026-01-21', days: 235, sourceName: 'Pixel Watch 4' },
        { metric: 'floors', tier: 'provider', localDate: '2026-02-02', value: 42, from: '2024-08-25', days: 230, sourceName: null },
      ],
    })
    for (const row of Array.from(container!.querySelectorAll('.record-row'))) {
      expect(row.children.length, row.getAttribute('data-metric') ?? '').toBe(5)
    }
  })

  // The session rows share .record-row's columns deliberately, so they need the same rule: the
  // activity is absent on a session whose device recorded no type, and an omitted cell there
  // would misalign that row against the two beside it.
  it('holds the activity column on a session record whose device recorded no type', () => {
    mountPage({
      ...EMPTY,
      sessionRecords: [
        { category: 'run', kind: 'longest', sessionId: 'a', localDate: '2026-06-19', exerciseType: 'RUNNING', value: 60 * 60_000 },
        { category: 'run', kind: 'furthest', sessionId: 'b', localDate: '2026-09-12', exerciseType: null, value: 12_850 },
      ],
    })
    for (const row of Array.from(container!.querySelectorAll('[data-record] > .record-row-link'))) {
      expect(row.children.length, row.parentElement!.getAttribute('data-record') ?? '').toBe(4)
      expect(row.lastElementChild!.className).toBe('record-source')
    }
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
