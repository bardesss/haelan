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

describe('the night page without a night', () => {
  it('says no night was recorded on a date the server has none for', async () => {
    const host = await mount(null)
    expect(host.innerHTML).toContain('No night recorded')
    expect(host.querySelector('.night-page')).toBeNull()
  })
})
