// @vitest-environment happy-dom
//
// happy-dom because the page's arrows are buttons that navigate on click, and the only way to see
// where one goes is to press it and read the URL it left behind.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import { nightPageKey } from '../src/data/useNightPage.js'
import type { NightPageData } from '../src/data/useNightPage.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { NightDetail } from '../src/pages/NightDetail.js'
import { navigate } from '../src/router.js'
import { pumpUntil } from './flush.js'
import { NIGHT_DATE, NIGHT_NEXT, NIGHT_PREVIOUS, nightPageFixture, withBlankFigures } from './fixtures/nightPage.js'

// happy-dom applies no stylesheet, so the page's charts throw "missing chart token" without this.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null
let restoreFetch: (() => void) | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', `/sleep/night/${NIGHT_DATE}`)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  restoreFetch?.()
  restoreFetch = null
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 450, sleepUseBaseline: false, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * Everything the page asks for beyond what the cache is seeded with: the old sections still below
 * the new ones (NightTraces' intraday windows, NightSessions' notes), all answering empty, and the
 * night page itself answering 404, which only the missing-night case ever reaches - every other
 * case seeds that key and never fetches it.
 */
function stubFetch(): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/night/')) return json({ error: { code: 'not_found', reason: 'no_such_night', message: 'no night' } }, 404)
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({ items: [], cursor: null })
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
}

async function mount(page: NightPageData | null): Promise<HTMLDivElement> {
  stubFetch()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  if (page !== null) client.setQueryData(nightPageKey('p1', NIGHT_DATE), page)
  act(() => {
    root!.render(<I18nProvider lng="en"><QueryClientProvider client={client}><NightDetail /></QueryClientProvider></I18nProvider>)
  })
  await pumpUntil(() => !container!.innerHTML.includes('>Loading<'), 'the night page to leave its loading state')
  await pumpUntil(() => client.isFetching() + client.isMutating() === 0, 'the page to have nothing left in flight')
  return container!
}

const text = (host: ParentNode, selector: string) => host.querySelector(selector)?.textContent
const button = (host: ParentNode, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

// Each mini row as [label, value, verdict], read cell by cell rather than as one run of text, so a
// value that changed format ("94" for "94 %") fails on its own cell.
function minis(host: ParentNode): string[][] {
  return [...host.querySelectorAll('.night-minis .figure-row')].map((row) => [
    text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '', text(row, '.figure-row-verdict') ?? '',
  ])
}

describe('the night page\'s top', () => {
  it('is titled with the night\'s date and says when it ran and who recorded it', async () => {
    const host = await mount(nightPageFixture())
    expect(text(host, '.night-page h1')).toBe('Sunday, September 6')
    // Bed and wake are the page's own bedtime and wake time figures, 00:08 and 07:09.
    expect(text(host, '.night-when')).toBe('00:08 to 07:09 · watch')
  })

  it('steps to the neighbouring nights the payload names', async () => {
    const host = await mount(nightPageFixture())
    act(() => { button(host, 'Previous night')!.click() })
    expect(window.location.pathname).toBe(`/sleep/night/${NIGHT_PREVIOUS}`)
    // Back through the router, so the page re-renders on the seeded night rather than the one it
    // just stepped to, which this cache has no answer for.
    act(() => { navigate(`/sleep/night/${NIGHT_DATE}`) })
    act(() => { button(host, 'Next night')!.click() })
    expect(window.location.pathname).toBe(`/sleep/night/${NIGHT_NEXT}`)
  })

  it('keeps the reader\'s source when it steps', async () => {
    window.history.replaceState(null, '', `/sleep/night/${NIGHT_DATE}?source=phone`)
    const host = await mount(nightPageFixture())
    act(() => { button(host, 'Previous night')!.click() })
    expect(window.location.pathname + window.location.search).toBe(`/sleep/night/${NIGHT_PREVIOUS}?source=phone`)
  })

  it('disables the arrow with no night behind it', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, nav: { previous: NIGHT_PREVIOUS, next: null } })
    expect(button(host, 'Next night')!.disabled).toBe(true)
    expect(button(host, 'Previous night')!.disabled).toBe(false)
  })

  it('links back to every night', async () => {
    const host = await mount(nightPageFixture())
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'All nights →')
    expect(link?.getAttribute('href')).toBe('/sleep')
  })
})

describe('the night page\'s hero', () => {
  it('leads with the time asleep and where it sits against the usual', async () => {
    const host = await mount(nightPageFixture())
    expect(host.querySelector('.night-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Time asleep')
    expect(text(host, '.night-hero-value')).toBe('6h 36m')
    expect(text(host, '.night-hero-verdict')).toBe('within your usual 5h 06m – 7h 48m')
    expect(text(host, '.night-hero .dash-caption')).toBe('this night and the six before it')
    expect(host.querySelector('.night-hero [role="img"][aria-label="Time asleep"]')).not.toBeNull()
  })
})

describe('the night page\'s four figures', () => {
  it('are efficiency, deep sleep, REM and bedtime, each with its verdict', async () => {
    const host = await mount(nightPageFixture())
    expect(minis(host)).toEqual([
      ['Efficiency', '94 %', 'within your usual 88 % – 96 %'],
      ['Deep sleep', '1h 04m', 'below your usual 1h 10m – 1h 40m'],
      ['REM', '2h 03m', 'within your usual 1h 30m – 2h 10m'],
      ['Bedtime', '00:08', 'within your usual 23:30 – 00:20'],
    ])
    // Deep sleep is short, and the server said that is worse; the verdict carries its colour.
    expect(host.querySelectorAll('.night-minis .figure-row-verdict')[1]?.className).toBe('figure-row-verdict worse')
    expect(text(host, '.night-minis .dash-caption')).toBe('each line: this night and the six before it · band = your usual range')
  })

  it('leave out a figure the night has no reading for, and only that one', async () => {
    const host = await mount(withBlankFigures(nightPageFixture(), ['efficiency']))
    expect(minis(host).map(([label]) => label)).toEqual(['Deep sleep', 'REM', 'Bedtime'])
  })

  it('leave out the whole card when none of the four has a reading', async () => {
    const host = await mount(withBlankFigures(nightPageFixture(), ['efficiency', 'deep', 'rem', 'bedtime']))
    expect(host.querySelector('.night-minis')).toBeNull()
    expect(host.querySelector('.night-hero')).not.toBeNull()
    // The card itself, not only its rows: a frame holding just its caption would still take a row.
    expect(host.textContent).not.toContain('each line: this night and the six before it')
  })
})

describe('the night page\'s night card', () => {
  it('draws the stages under its own label, with each stage\'s time and share of the night', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('.night-legend')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('The night')
    expect(card?.querySelector('[role="img"][aria-label="The night"]')).not.toBeNull()
    // Deep, light and REM carry the server's share of the night; awake is its minutes alone.
    expect([...host.querySelectorAll('.night-legend li')].map((item) => item.textContent)).toEqual([
      'Deep 1h 04m · 16 %', 'Light 3h 29m · 53 %', 'REM 2h 03m · 31 %', 'Awake 0h 25m',
    ])
    expect(card?.querySelector('.night-naps')?.textContent).toBe('No naps recorded on this date.')
  })

  // The fixture's awake figure and its awake lane agree at 25 minutes, so the note stays away.
  it('says nothing about awake time when the lane and the night\'s figure agree', async () => {
    const host = await mount(nightPageFixture())
    expect(host.textContent).not.toContain('Awake counts the awake stages drawn above')
  })

  it('says why the awake lane reads lower when the night\'s own figure counts more', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, figures: { ...page.figures, awake: { ...page.figures.awake, value: 40 } } })
    expect(text(host, '.night-legend + .hypnogram-totals')).toBe('Awake counts the awake stages drawn above and nothing '
      + 'else. The night\'s own awake minutes also count restless time and the gaps between the night\'s separate '
      + 'pieces, so that figure reads higher.')
  })

  it('leaves a stage\'s share off when the server sent none for it', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, stagePercent: { ...page.stagePercent, rem: null } })
    expect([...host.querySelectorAll('.night-legend li')].map((item) => item.textContent)[2]).toBe('REM 2h 03m')
  })
})

describe('the night page\'s week', () => {
  it('draws the week\'s bed and wake times in the schedule card, and how much bedtime varied', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('[aria-label="Sleep schedule"]')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('Sleep schedule')
    expect(card?.querySelectorAll('tbody tr')).toHaveLength(7)
    expect(card?.textContent).toContain('Bedtime varied ±0h 28m this week')
    expect(card?.textContent).toContain('within your usual 0h 20m – 0h 35m')
  })

  it('hides the schedule card when neither bedtime nor waketime carries a strip', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      figures: {
        ...page.figures,
        bedtime: { ...page.figures.bedtime, strip: null },
        waketime: { ...page.figures.waketime, strip: null },
      },
    })
    expect(host.querySelector('[aria-label="Sleep schedule"]')).toBeNull()
    // The balance card, its neighbour in the same row, is unaffected.
    expect(host.querySelector('[aria-label="Sleep balance"]')).not.toBeNull()
  })

  it('totals the week\'s balance, signed, against the target it was drawn from', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('[aria-label="Sleep balance"]')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('Sleep balance')
    expect(card?.textContent).toContain('-7h 24m')
    expect(card?.textContent).toContain('against your target of 7h 30m')
    expect(card?.querySelectorAll('tbody tr')).toHaveLength(7)
  })

  it('names the usual instead of a target when the zero line is the baseline', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, balance: { ...page.balance, zeroLine: { minutes: 400, source: 'baseline' } } })
    const card = host.querySelector('[aria-label="Sleep balance"]')?.closest('.card')
    expect(card?.textContent).toContain('against your usual 6h 40m')
  })
})

describe('the night page\'s morning after', () => {
  it('labels the card "The morning after" when the recovery it shows is this same night\'s morning', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('.night-grp')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('The morning after')
  })

  it('names the recovery\'s own date instead when it belongs to a different day', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      morning: { ...page.morning, recovery: { ...page.morning.recovery, index: { ...page.morning.recovery.index, asOfDate: NIGHT_PREVIOUS } } },
    })
    const card = host.querySelector('.night-grp')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('Recovery on Sep 5, 2026')
  })

  it('draws the recovery ring with the index and its band, resting HR and HRV as strips, and breathing, oxygen and skin temperature as bars', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('.night-grp')?.closest('.card')!
    expect(card.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Recovery index 68')
    expect(card.querySelector('.score-ring-value')?.textContent).toBe('68')
    expect(card.textContent).toContain('Around your usual')

    const rows = [...card.querySelectorAll('.figure-row')].map((row) => [
      text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '', text(row, '.figure-row-verdict') ?? '',
    ])
    expect(rows).toEqual([
      ['Resting HR', '54 bpm', 'within your usual 51 bpm – 57 bpm'],
      ['HRV', '49 ms', 'within your usual 42 ms – 60 ms'],
      ['Breathing in sleep', '14.2 breaths/min', 'within your usual 13.0 breaths/min – 15.5 breaths/min'],
      ['Oxygen (SpO2)', '95.4 %', 'within your usual 94.5 % – 97.0 %'],
      ['Skin temperature', '+0.6 °C', 'above your usual 32.7 °C – 33.3 °C'],
    ])
    // Resting HR and HRV are the two rows with a trend (a strip); breathing, oxygen and skin
    // temperature draw a bar instead, the mockup's own split.
    expect(card.querySelectorAll('[role="img"][aria-label="Resting HR"]')).toHaveLength(1)
    expect(card.querySelectorAll('[role="img"][aria-label="HRV"]')).toHaveLength(1)
    expect(card.querySelectorAll('.figure-row-bar')).toHaveLength(3)
  })

  it('says there is no usual to compare against rather than leaving a row\'s hidden description empty', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      morning: { ...page.morning, restingHeartRate: { ...page.morning.restingHeartRate, baseline: null, standing: null, judged: null } },
    })
    const card = host.querySelector('.night-grp')?.closest('.card')!
    expect(text(card, '.figure-row-verdict')).toBe('no baseline yet to compare against')
  })

  it('leaves out a reading the morning has none for, and only that one', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, morning: { ...page.morning, breathing: { ...page.morning.breathing, value: null } } })
    const card = host.querySelector('.night-grp')?.closest('.card')!
    const labels = [...card.querySelectorAll('.figure-row-label')].map((el) => el.textContent)
    expect(labels).toEqual(['Resting HR', 'HRV', 'Oxygen (SpO2)', 'Skin temperature'])
  })

  it('hides the whole card when the morning has nothing at all', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      morning: {
        recovery: { ...page.morning.recovery, index: { ...page.morning.recovery.index, value: null, asOfDate: null }, band: null },
        restingHeartRate: { ...page.morning.restingHeartRate, value: null, standing: null, judged: null },
        hrv: { ...page.morning.hrv, value: null, standing: null, judged: null },
        breathing: { ...page.morning.breathing, value: null, standing: null, judged: null },
        spo2: { ...page.morning.spo2, value: null, standing: null, judged: null },
        skinTemperature: { ...page.morning.skinTemperature, value: null, standing: null, judged: null },
        skinTemperatureDeviation: null,
      },
    })
    expect(host.querySelector('.night-grp')).toBeNull()
  })
})

describe('the night page\'s more about the sleep', () => {
  it('draws every remaining figure with its own verdict, in the mockup\'s order', async () => {
    const host = await mount(nightPageFixture())
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'More about the sleep')!
    const rows = [...card.querySelectorAll('.figure-row')].map((row) => [
      text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '', text(row, '.figure-row-verdict') ?? '',
    ])
    expect(rows).toEqual([
      ['Light sleep', '3h 29m', 'within your usual 3h 00m – 4h 00m'],
      ['Awake in bed', '0h 25m', 'within your usual 0h 10m – 0h 40m'],
      ['Time in bed', '7h 01m', 'within your usual 6h 00m – 8h 20m'],
      ['Wake time', '07:09', 'within your usual 06:30 – 07:30'],
      ['Time to fall asleep', '0h 12m', 'within your usual 0h 05m – 0h 20m'],
      ['Times woken', '14', 'within your usual 8 – 18'],
      ['Minutes after waking', '0h 04m', 'within your usual 0h 00m – 0h 10m'],
      ['Naps', 'none', 'within your usual 0 – 1'],
    ])
    expect(card.querySelectorAll('.figure-row-bar')).toHaveLength(rows.length)
  })

  it('reads the naps row as its minutes once there was at least one', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      figures: { ...page.figures, napCount: { ...page.figures.napCount, value: 1 }, napMinutes: { ...page.figures.napMinutes, value: 22, standing: 'within' } },
    })
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'More about the sleep')!
    expect(text(card, '.figure-row:last-child .figure-row-value')).toBe('0h 22m')
  })

  it('leaves out a figure the night has no reading for, and only that one', async () => {
    const host = await mount(withBlankFigures(nightPageFixture(), ['light', 'awakenings']))
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'More about the sleep')!
    const labels = [...card.querySelectorAll('.figure-row-label')].map((el) => el.textContent)
    expect(labels).toEqual(['Awake in bed', 'Time in bed', 'Wake time', 'Time to fall asleep', 'Minutes after waking', 'Naps'])
  })

  it('leaves out the whole card when nothing on it has a reading', async () => {
    const host = await mount(withBlankFigures(nightPageFixture(), [
      'light', 'awake', 'inBed', 'waketime', 'minutesToFallAsleep', 'awakenings', 'minutesAfterWakeUp', 'napCount',
    ]))
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'More about the sleep')
    expect(card).toBeUndefined()
  })
})

describe('the night page\'s day before it', () => {
  it('draws the mood, the chips with their counts, the note, steps, active minutes and the workout', async () => {
    const host = await mount(nightPageFixture())
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'That day')!
    expect(card.querySelector('.basis')?.textContent).toBe('Saturday, September 5, the day before this night')
    // The face itself is decorative (aria-hidden): the word beside it is what a screen reader
    // announces, and this asserts the word is present rather than assuming the face's own markup.
    expect(card.querySelector('.night-day-mood [aria-hidden="true"]')).not.toBeNull()
    expect(card.querySelector('.night-day-mood-word')?.textContent).toBe('Good')
    // The fixture's only counted kind, alcohol, was tapped twice, so its chip carries the count;
    // a chip for a kind tapped once would carry none (the brief's own "count shown when > 1").
    expect([...card.querySelectorAll('.night-day-chip')].map((chip) => chip.textContent)).toEqual(['Alcohol ×2'])
    expect(card.querySelector('.night-day-note')?.textContent).toBe('“Birthday, home late.”')
    const rows = [...card.querySelectorAll('.figure-row')].map((row) => [
      text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '',
    ])
    expect(rows[0]).toEqual(['Steps', '11,240'])
    expect(rows[1]).toEqual(['Active minutes', '0h 48m'])
    expect(rows[2]?.[0]).toBe('Training')
    const workoutLink = card.querySelector<HTMLAnchorElement>('.night-day-workout-link')
    expect(workoutLink?.textContent).toBe('Biking 52 min')
    expect(workoutLink?.getAttribute('href')).toBe('/activity/w1')
  })

  it('shows the workout\'s average heart rate when its metricsSummary carries one', async () => {
    const page = nightPageFixture()
    // The stored provider shape (workoutSummary.ts's own comment on it): metricsSummary is a
    // nested object, and averageHeartRateBeatsPerMinute arrives as a string there, not a number -
    // the fixture's own plain `attrs: { averageHeartRate: 131 }` is not a shape workoutSummary
    // reads at all, which is exactly why this never showed against that fixture on its own.
    const host = await mount({
      ...page,
      day: {
        ...page.day,
        workouts: [{
          ...page.day.workouts[0]!,
          attrs: { exerciseType: 'BIKING', metricsSummary: { averageHeartRateBeatsPerMinute: '131' } },
        }],
      },
    })
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'That day')!
    expect(card.textContent).toContain('average 131 bpm')
  })

  it('shows a chip with no count for a kind tapped only once', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, log: { ...page.log, counts: { alcohol: 1 } } })
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'That day')!
    expect([...card.querySelectorAll('.night-day-chip')].map((chip) => chip.textContent)).toEqual(['Alcohol'])
  })

  it('hides the whole card when the day has no log, no figures and no workout', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      day: {
        ...page.day,
        steps: { ...page.day.steps, value: null, standing: null, judged: null },
        activeMinutes: { ...page.day.activeMinutes, value: null, standing: null, judged: null },
        workouts: [],
      },
      log: { ...page.log, mood: null, counts: {}, note: null },
    })
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'That day')
    expect(card).toBeUndefined()
  })
})

describe('the night page\'s about fold', () => {
  it('holds the session list and the excluded-sessions notice, closed by default', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, night: { ...page.night, sessionIds: ['s1'], excludedSessions: ['s2'] } })
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'About this night')!
    const details = card.querySelector('details.night-about')
    // happy-dom does not hide a closed <details>' own children, so this asserts the `open`
    // attribute itself rather than visibility (this file's own comment on why, task 7's brief).
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toBe('Details')
    expect(details?.querySelectorAll('.night-session')).toHaveLength(2)
    expect(details?.textContent).toContain('1 sleep session excluded from this night')
  })
})

describe('the night page without a night', () => {
  it('says no night was recorded on a date the server has none for', async () => {
    const host = await mount(null)
    expect(host.innerHTML).toContain('No night recorded')
    expect(host.querySelector('.night-page')).toBeNull()
  })
})
