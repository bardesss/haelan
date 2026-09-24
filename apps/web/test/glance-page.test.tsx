// @vitest-environment happy-dom
// happy-dom: every case here mounts the Dashboard for real and lets its query settle. The
// card-level cases that used to open this file went with GlanceCard; each redesigned card is held
// on its own in dashboard-cards.test.tsx, and this file keeps what only the assembled page can show.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Dashboard } from '../src/pages/Dashboard.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { Session } from '../src/auth/session.js'
import type { Glance, GlanceFigure } from '../src/data/useGlance.js'
import type { WorkoutSession } from '../src/data/useSessions.js'
import { glanceBody, glanceFigure } from './glanceFixture.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same setup every other file mounting a chart for real carries.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const TODAY = '2026-09-23'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
  // The greeting reads the clock: 09:40 UTC is 11:40 in Amsterdam, a morning. Only Date is faked,
  // so React Query's timers and flush's own waits still run.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 40))
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

/**
 * Answers /glance with `body` (or a 500 when `status` says so), /sources with one named watch for
 * the heart rate trace's legend, and records every URL asked for, so a test can hold the page to
 * the one read it claims to make.
 */
function stubFetch(body: Glance, seen: string[], status = 200): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    const json = (value: unknown, code = 200) =>
      new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
    if (url.includes('/glance')) return status === 200 ? json(body) : json({ error: 'internal' }, status)
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function mountPage(body: Glance = glanceBody(), o: { lng?: string, status?: number } = {}): Promise<{ seen: string[], client: QueryClient, restore: () => void }> {
  const seen: string[] = []
  const restore = stubFetch(body, seen, o.status)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  const tree: ReactNode = (
    <I18nProvider lng={o.lng ?? 'en'}><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></I18nProvider>
  )
  act(() => { root!.render(tree) })
  await flush(client, () => container!.innerHTML)
  return { seen, client, restore }
}

/** A run this morning, 08:00-08:45 in Amsterdam, as the glance's `day.workouts` carries one. */
const TODAY_RUN: WorkoutSession = {
  id: 'run1', sourceId: 'watch',
  startMs: Date.UTC(2026, 8, 23, 6, 0), endMs: Date.UTC(2026, 8, 23, 6, 45),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: TODAY,
  attrs: { exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 412 } },
  excluded: false, excludeReason: null, sources: ['watch'], alternateIds: [],
}


const cards = (): Element[] => [...container!.querySelectorAll('.dashboard-grid > section.card')]
const titles = (): string[] => [...container!.querySelectorAll('.dash-card-title strong')].map((el) => el.textContent ?? '')
const cardTitled = (title: string): Element | undefined =>
  cards().find((card) => card.querySelector('.dash-card-title strong')?.textContent === title)
const dateLine = (): string | null | undefined => container!.querySelector('.dash-date')?.textContent

describe('the glance Dashboard', () => {
  it('greets, then draws last night beside recovery and today beside the week', async () => {
    const { restore } = await mountPage()
    try {
      const page = container!.firstElementChild!
      expect(page.className).toBe('dashboard')
      // The greeting, then the date and span line, then the grid, in that order.
      expect([...page.children].map((el) => [el.tagName.toLowerCase(), el.className]))
        .toEqual([['h1', ''], ['p', 'dash-date'], ['div', 'grid dashboard-grid']])
      expect(page.querySelector('h1')?.textContent).toBe('Good morning')
      expect(titles()).toEqual(['Last night', 'Recovery', 'Today', 'This week'])
      expect(cards().map((card) => card.getAttribute('data-span'))).toEqual(['8', '4', '8', '4'])
    } finally { restore() }
  })

  it('greets by the person\'s clock, not the machine\'s', async () => {
    // 16:30 UTC is 18:30 in Amsterdam: evening there, whatever zone the test runner sits in.
    vi.setSystemTime(Date.UTC(2026, 8, 23, 16, 30))
    const { restore } = await mountPage()
    try {
      expect(container!.querySelector('h1')?.textContent).toBe('Good evening')
    } finally { restore() }
  })

  it('has no control row', async () => {
    const { restore } = await mountPage()
    try {
      expect(container!.querySelector('.controls')).toBeNull()
    } finally { restore() }
  })

  it('links the night card to the night it draws, and draws that night\'s hypnogram', async () => {
    const { restore } = await mountPage()
    try {
      const night = cards()[0]!
      expect(night.querySelector('a.card-link')?.getAttribute('href')).toBe('/sleep/night/2026-09-23')
      expect(night.querySelector('[role="img"][aria-label^="Sleep stages through the night of"]')).not.toBeNull()
      // The Bed pair reads the stored bedtime, -50 minutes from the wake date's midnight.
      const bed = [...night.querySelectorAll('.dash-mini')].find((d) => d.querySelector('.dash-mini-label')?.textContent === 'Bed')
      expect(bed?.querySelector('.dash-mini-value')?.textContent).toBe('23:10')
      // The night spans two dates, and the subtitle names both.
      expect(night.querySelector('.dash-card-title span')?.textContent).toMatch(/22.*23/)
    } finally { restore() }
  })

  // No night: recovery takes the top row to itself, wide, rather than a night card saying there
  // was nothing to say.
  it('leads with a wide recovery card when there is no night', async () => {
    const { restore } = await mountPage({ ...glanceBody(), sleep: null })
    try {
      expect(titles()).toEqual(['Recovery', 'Today', 'This week'])
      const recovery = cards()[0]!
      expect(recovery.getAttribute('data-span')).toBe('12')
      expect(recovery.querySelector('.dash-card')?.className).toBe('dash-card dash-recovery is-wide')
      expect(container!.querySelector('a[href^="/sleep"]')).toBeNull()
    } finally { restore() }
  })

  it('shows the breathing rate note only on a day the payload carries one', async () => {
    const plain = await mountPage()
    try {
      expect(cardTitled('Recovery')!.querySelector('.glance-note')).toBeNull()
    } finally { plain.restore() }
    act(() => { root!.unmount() })
    root = createRoot(container!)

    const body = glanceBody()
    body.recovery.respiratoryRate = glanceFigure({ metric: 'respiratory_rate', value: 17.2, unit: 'breaths_per_minute' })
    const elevated = await mountPage(body)
    try {
      expect(cardTitled('Recovery')!.querySelector('.glance-note')?.textContent).toMatch(/^Breathing rate 17\.2 .*, above your usual$/)
    } finally { elevated.restore() }
  })

  // The fixture's index carries baseline: null, as core always sends it, so the only words under
  // the dials are the band's.
  it('states the recovery band under the dials', async () => {
    const { restore } = await mountPage()
    try {
      expect(cardTitled('Recovery')!.querySelector('.dash-recovery-words')?.textContent).toBe('Around your usual')
    } finally { restore() }
  })

  it('says it has nothing yet, once, when the glance holds no value at all', async () => {
    const body = glanceBody()
    const empty = (f: GlanceFigure): GlanceFigure => ({ ...f, value: null, asOfDate: null, asOfMs: null, strip: [] })
    const nothing: Glance = {
      ...body,
      sleep: null,
      recovery: {
        ...body.recovery, band: null, missing: ['resting_heart_rate'],
        index: empty(body.recovery.index), restingHeartRate: empty(body.recovery.restingHeartRate), hrv: empty(body.recovery.hrv),
        respiratoryRate: null,
      },
      day: {
        steps: empty(body.day.steps), stepsPace: null, activeMinutes: empty(body.day.activeMinutes),
        heartRate: { points: [], asOfMs: null, staleSources: [] },
        workouts: [],
      },
    }
    const { restore } = await mountPage(nothing)
    try {
      expect(container!.querySelectorAll('.card')).toHaveLength(0)
      expect(container!.querySelector('h1')?.textContent).toBe('Good morning')
      expect(container!.querySelector('.empty')?.textContent)
        .toBe('Nothing here yetOnce a sync brings in a night or a day, it shows up here.')
      // Not the not_synced words, which mean the person turned a data type off.
      expect(container!.textContent).not.toContain('Not being synced')
    } finally { restore() }
  })

  // One figure with a value is enough for the cards: the empty state is for a page with nothing.
  it('keeps the cards when a single figure has a value', async () => {
    const body = glanceBody()
    const empty = (f: GlanceFigure): GlanceFigure => ({ ...f, value: null })
    const oneFigure: Glance = {
      ...body,
      sleep: null,
      recovery: { ...body.recovery, index: empty(body.recovery.index), restingHeartRate: empty(body.recovery.restingHeartRate), hrv: empty(body.recovery.hrv) },
      day: { ...body.day, steps: empty(body.day.steps), heartRate: { points: [], asOfMs: null, staleSources: [] } },
    }
    const { restore } = await mountPage(oneFigure)
    try {
      expect(titles()).toEqual(['Recovery', 'Today', 'This week'])
    } finally { restore() }
  })

  // "On the today tab, you should also see the activities you did." The glance carries today's
  // workouts, already merged across sources by the server, and each row opens the workout's page.
  it('lists today\'s workouts inside the today card, each linking to its page', async () => {
    const body = glanceBody()
    body.day.workouts = [TODAY_RUN, { ...TODAY_RUN, id: 'swim1', startMs: TODAY_RUN.startMs + 4 * 3_600_000, endMs: TODAY_RUN.endMs + 4 * 3_600_000, attrs: { exerciseType: 'SWIMMING_POOL' } }]
    const { restore } = await mountPage(body)
    try {
      // The today card's own list, not a fifth card.
      expect(container!.querySelectorAll('.card')).toHaveLength(4)
      const list = container!.querySelector('.today-workouts')!
      expect(list.closest('.card')).toBe(cardTitled('Today'))
      expect(list.querySelector('.label')?.textContent).toBe('Today\'s activities')
      // Oldest first, the order the day happened in, rather than the Activity list's newest first.
      expect([...list.querySelectorAll('a.session-row-link')].map((a) => a.getAttribute('href')))
        .toEqual(['/activity/run1', '/activity/swim1'])
      expect(list.querySelector('.session-row-type')?.textContent).toBe('Running')
    } finally { restore() }
  })

  // Hidden, not an empty card: a morning before the run is not a morning with nothing to say.
  it('draws no workouts list on a day with none', async () => {
    const { restore } = await mountPage()
    try {
      expect(container!.querySelector('.today-workouts')).toBeNull()
      expect(container!.querySelectorAll('.card')).toHaveLength(4)
    } finally { restore() }
  })

  it('keeps the page when a workout is the only thing today holds', async () => {
    const body = glanceBody()
    const empty = (f: GlanceFigure): GlanceFigure => ({ ...f, value: null, asOfDate: null, asOfMs: null, strip: [] })
    const onlyARun: Glance = {
      ...body,
      sleep: null,
      recovery: {
        ...body.recovery, band: null, missing: ['resting_heart_rate'],
        index: empty(body.recovery.index), restingHeartRate: empty(body.recovery.restingHeartRate), hrv: empty(body.recovery.hrv),
        respiratoryRate: null,
      },
      day: {
        steps: empty(body.day.steps), stepsPace: null, activeMinutes: empty(body.day.activeMinutes),
        heartRate: { points: [], asOfMs: null, staleSources: [] },
        workouts: [TODAY_RUN],
      },
    }
    const { restore } = await mountPage(onlyARun)
    try {
      expect(container!.querySelector('.today-workouts a.session-row-link')?.getAttribute('href')).toBe('/activity/run1')
      expect(container!.textContent).not.toContain('Nothing here yet')
    } finally { restore() }
  })

  it('names the workouts list in Dutch', async () => {
    const body = glanceBody()
    body.day.workouts = [TODAY_RUN]
    const { restore } = await mountPage(body, { lng: 'nl' })
    try {
      expect(container!.querySelector('.today-workouts .label')?.textContent).toBe('Activiteiten van vandaag')
    } finally { restore() }
  })

  // Once: the words under the dials, not a "No reading yet" as well.
  it('says why recovery is unscored once, and still draws the resting heart rate and HRV', async () => {
    const body = glanceBody()
    body.recovery.index = glanceFigure({ metric: 'recovery_index', value: null, unit: 'score', asOfDate: null })
    const { restore } = await mountPage(body)
    try {
      const recovery = cardTitled('Recovery')!
      expect(recovery.textContent!.split('Not enough readings to score yet.')).toHaveLength(2)
      expect(recovery.querySelector('.dash-recovery-words')?.textContent).toBe('Not enough readings to score yet.')
      expect(recovery.querySelector('.glance-note')).toBeNull()
      expect(recovery.textContent).not.toContain('No reading yet')
      expect([...recovery.querySelectorAll('.dash-dial > .label')].map((l) => l.textContent)).toEqual(['Resting HR', 'Score', 'HRV'])
      expect(recovery.querySelectorAll('.usual-gauge')).toHaveLength(2)
    } finally { restore() }
  })

  // The subtitle names the day, so a figure on that same day does not name it again.
  it('names recovery\'s day once, in the subtitle', async () => {
    const { restore } = await mountPage()
    try {
      const recovery = cardTitled('Recovery')!
      expect(recovery.querySelector('.dash-card-title span')?.textContent).toBe('today')
      expect(recovery.querySelector('.glance-asof')).toBeNull()
    } finally { restore() }
  })

  it('keeps a recovery gauge\'s own day when it is not the index\'s', async () => {
    const body = glanceBody()
    body.recovery.hrv = { ...body.recovery.hrv, asOfDate: '2026-09-22' }
    const { restore } = await mountPage(body)
    try {
      const hrv = [...cardTitled('Recovery')!.querySelectorAll('.dash-dial')].find((d) => d.querySelector('.label')?.textContent === 'HRV')
      expect(hrv?.querySelector('.glance-asof')?.textContent).toBe('yesterday')
    } finally { restore() }
  })

  // A classic night (ASLEEP and RESTLESS only) draws an empty chart, which must still say why. The
  // night card keeps the hypnogram's totals row, so the reason sits where the totals would.
  it('still says an unstaged night was not staged', async () => {
    const body = glanceBody()
    body.sleep = { ...body.sleep!, segments: body.sleep!.segments.map((s) => ({ ...s, stage: 'ASLEEP' })) }
    const { restore } = await mountPage(body)
    try {
      expect(cards()[0]!.querySelector('.hypnogram-totals')?.textContent).toBe('This night was not staged, so there is nothing to total.')
    } finally { restore() }
  })

  // Steps feeds both the Today card and the Week card's own steps row, so a source gone quiet on
  // it marks both - never a card that never draws on it (Recovery, Night).
  it('puts a stale source on steps beside the Today and Week cards\' titles, and nowhere else', async () => {
    const body = glanceBody()
    body.day.steps = { ...body.day.steps, staleSources: [{ sourceId: 's1', name: 'My watch', lastReportedDate: '2026-09-10', medianGapDays: 1 }] }
    const { restore } = await mountPage(body)
    try {
      expect(container!.querySelectorAll('.source-warning')).toHaveLength(2)
      const sentence = 'My watch has not reported since Sep 10, 2026; it usually reports daily.'
      expect(cardTitled('Today')!.querySelector('.dash-card-head > .source-warning')?.getAttribute('title')).toBe(sentence)
      expect(cardTitled('This week')!.querySelector('.dash-card-head > .source-warning')?.getAttribute('title')).toBe(sentence)
    } finally { restore() }
  })

  // The date is the glance's own today, read in the person's language; the span after it is the
  // heart rate's last reading in the person's zone.
  it('states the date and its span from the heart rate\'s last reading, in the person\'s zone', async () => {
    const { restore } = await mountPage()
    try {
      // 09:38 UTC is 11:38 in Amsterdam; the steps' own 09:32 must not be the one it reads.
      expect(dateLine()).toBe('Wednesday, September 23 · last night, and today until 11:38')
    } finally { restore() }
  })

  it('falls back to the steps\' last reading, and to no time at all', async () => {
    const body = glanceBody()
    body.day.heartRate = { ...body.day.heartRate, asOfMs: null }
    const stepsOnly = await mountPage(body)
    try {
      expect(dateLine()).toBe('Wednesday, September 23 · last night, and today until 11:32')
    } finally { stepsOnly.restore() }
    act(() => { root!.unmount() })
    root = createRoot(container!)

    const none = glanceBody()
    none.day.heartRate = { ...none.day.heartRate, asOfMs: null }
    none.day.steps = { ...none.day.steps, asOfMs: null }
    const neither = await mountPage(none)
    try {
      expect(dateLine()).toBe('Wednesday, September 23 · last night, and today so far')
    } finally { neither.restore() }
  })

  // "Last night" would be a claim about a night the page does not have.
  it('says no night was recorded in the span line when there is none', async () => {
    const withTime = await mountPage({ ...glanceBody(), sleep: null })
    try {
      expect(dateLine()).toBe('Wednesday, September 23 · no night recorded · today until 11:38')
    } finally { withTime.restore() }
    act(() => { root!.unmount() })
    root = createRoot(container!)

    const none = glanceBody()
    none.sleep = null
    none.day.heartRate = { ...none.day.heartRate, asOfMs: null }
    none.day.steps = { ...none.day.steps, asOfMs: null }
    const noTime = await mountPage(none)
    try {
      expect(dateLine()).toBe('Wednesday, September 23 · no night recorded · today so far')
    } finally { noTime.restore() }
  })

  // The locale parity guard compares key sets and never renders, so the Dutch page is rendered
  // once here to see that it reads as Dutch.
  it('renders in Dutch', async () => {
    const { restore } = await mountPage(glanceBody(), { lng: 'nl' })
    try {
      expect(container!.querySelector('h1')?.textContent).toBe('Goedemorgen')
      expect(titles()).toEqual(['Afgelopen nacht', 'Herstel', 'Vandaag', 'Deze week'])
      expect(dateLine()).toBe('woensdag 23 september · afgelopen nacht, en vandaag tot 11:38')
      expect(container!.textContent).toContain('Stappen')
      expect(container!.textContent).not.toMatch(/\bglance\.[a-zA-Z]/)
      // One usual sentence and one as-of line, read whole: the parity guard never renders, and
      // these once ended on a bare adjective ("boven je gebruikelijke 52 – 60") with every test green.
      const rhr = cardTitled('Herstel')!.querySelector('.usual-gauge')
      expect(rhr?.getAttribute('aria-label')).toBe('Rusthartslag 62 bpm, boven je gebruikelijke bereik 52 – 60')
      expect(cardTitled('Vandaag')!.querySelector('.glance-asof')?.textContent).toBe('bijgewerkt om 11:38')
    } finally { restore() }
  })

  // The clock and the zone are known before the glance arrives, so the greeting does not wait for it.
  it('shows the loading state under the greeting while the glance is on its way', async () => {
    const original = globalThis.fetch
    // A /glance that never answers, so the page stays in its loading branch.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
      client.setQueryData(queryKeys.session(), PERSON)
      act(() => {
        root!.render(<I18nProvider lng="en"><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></I18nProvider>)
      })
      expect(container!.querySelector('h1')?.textContent).toBe('Good morning')
      expect(container!.querySelector('.empty')?.textContent).toBe('Loading')
      expect(container!.querySelectorAll('.card')).toHaveLength(0)
    } finally { globalThis.fetch = original }
  })

  it('shows the error state, under the greeting, with a retry that asks again', async () => {
    const { seen, client, restore } = await mountPage(glanceBody(), { status: 500 })
    try {
      expect(container!.querySelectorAll('.card')).toHaveLength(0)
      expect(container!.querySelector('h1')?.textContent).toBe('Good morning')
      const retry = container!.querySelector('button')
      expect(retry?.textContent).toBe('Try again')
      act(() => { retry!.click() })
      await flush(client, () => container!.innerHTML)
      expect(seen.filter((u) => u.includes('/glance'))).toHaveLength(2)
    } finally { restore() }
  })

  // Carried over from the old dashboard-cards.test.tsx with the same intent: the page and its night
  // card draw from the payload, never from the July fixtures module that NightCard's Stage comment cites.
  it('does not import the fixtures', () => {
    expect(readFileSync('apps/web/src/pages/Dashboard.tsx', 'utf8')).not.toContain('fixtures/july')
    expect(readFileSync('apps/web/src/pages/dashboard/NightCard.tsx', 'utf8')).not.toContain('fixtures/july')
  })

  // One read: the old Dashboard issued a dozen (series per agg, insights, nights, annotations).
  // /sources is the heart rate trace's own legend lookup (IntradayHeartRate's useSourceNames), a
  // name table rather than a read of anyone's data, so it is the one other request allowed.
  it('makes exactly one data request, to /glance', async () => {
    const { seen, restore } = await mountPage()
    try {
      const data = seen.filter((u) => !u.includes('/sources') && !u.includes('/api/auth/me'))
      expect(data).toEqual(['/api/v1/p/p1/glance'])
    } finally { restore() }
  })
})
