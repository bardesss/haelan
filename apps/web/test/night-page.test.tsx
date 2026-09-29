// @vitest-environment happy-dom
//
// happy-dom because the page's arrows are buttons that navigate on click, and the only way to see
// where one goes is to press it and read the URL it left behind.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
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
import * as echarts from 'echarts'
import { CHART_VARS } from '../src/charts/tokens.js'
import { NightDetail } from '../src/pages/NightDetail.js'
import { navigate } from '../src/router.js'
import { pumpUntil } from './flush.js'
import { NIGHT_DATE, NIGHT_NEXT, NIGHT_PREVIOUS, nightPageFixture, withBlankFigures } from './fixtures/nightPage.js'

// happy-dom applies no stylesheet, so the page's charts throw "missing chart token" without this.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')
// Except the warning colour, so a strip's out-of-usual day dot can be told from an ordinary one.
const NEGATIVE = '#ff0000'
document.documentElement.style.setProperty('--negative', NEGATIVE)

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
type NightAnswer = { status: number, body: unknown }
const NO_SUCH_NIGHT: NightAnswer = { status: 404, body: { error: { code: 'not_found', reason: 'no_such_night', message: 'no night' } } }

function stubFetch(night: NightAnswer = NO_SUCH_NIGHT): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/night/')) return json(night.body, night.status)
    if (url.includes('/intraday/window')) return json({ points: [], reduction: null })
    if (url.includes('/sources')) return json({ items: [] })
    return json({ items: [], cursor: null })
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
}

async function mount(page: NightPageData | null, lng: 'en' | 'nl' = 'en', night?: NightAnswer): Promise<HTMLDivElement> {
  stubFetch(night)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceNamesKey('p1'), { items: [] })
  if (page !== null) client.setQueryData(nightPageKey('p1', NIGHT_DATE), page)
  act(() => {
    root!.render(<I18nProvider lng={lng}><QueryClientProvider client={client}><NightDetail /></QueryClientProvider></I18nProvider>)
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
    expect(text(host, '.night-when')).toBe('Went to bed 00:08 · woke 07:09 · watch')
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

  it('is left out when the night has no time asleep', async () => {
    const host = await mount(withBlankFigures(nightPageFixture(), ['asleep']))
    expect(host.querySelector('.night-hero')).toBeNull()
    expect(host.textContent).not.toContain('Time asleep')
    // The rest of the page still draws.
    expect(host.querySelector('.night-minis')).not.toBeNull()
  })

  it('draws no strip for a figure with fewer than two nights to join', async () => {
    const page = nightPageFixture()
    const asleep = page.figures.asleep
    const lone = { ...asleep, strip: asleep.strip!.map((day, i, all) => (i === all.length - 1 ? day : { ...day, value: null })) }
    const host = await mount({ ...page, figures: { ...page.figures, asleep: lone } })
    expect(host.querySelector('.night-hero')).not.toBeNull()
    expect(host.querySelector('.night-hero [role="img"]')).toBeNull()
  })
})

describe('the night page in Dutch', () => {
  it('words the hero and the four figures from the Dutch catalogue', async () => {
    const host = await mount(nightPageFixture(), 'nl')
    expect(host.querySelector('.night-hero')?.closest('.card')?.querySelector('.label')?.textContent).toBe('Tijd in slaap')
    expect(text(host, '.night-hero-verdict')).toBe('binnen je gebruikelijke bereik 5h 06m – 7h 48m')
    expect(text(host, '.night-hero .dash-caption')).toBe('deze nacht en de zes ervoor')
    expect(minis(host)).toEqual([
      ['Efficiëntie', '94 %', 'binnen je gebruikelijke bereik 88 % – 96 %'],
      ['Diepe slaap', '1h 04m', 'onder je gebruikelijke bereik 1h 10m – 1h 40m'],
      ['REM', '2h 03m', 'binnen je gebruikelijke bereik 1h 30m – 2h 10m'],
      ['Naar bed', '00:08', 'binnen je gebruikelijke bereik 23:30 – 00:20'],
    ])
    expect(text(host, '.night-when')).toBe('Naar bed 00:08 · wakker 07:09 · watch')
  })

  it('names the hypnogram lanes in Dutch', async () => {
    const host = await mount(nightPageFixture(), 'nl')
    const chart = host.querySelector<HTMLDivElement>('[role="img"][aria-label="De nacht"]')!
    const option = echarts.getInstanceByDom(chart)?.getOption() as { yAxis: { data: string[] }[] }
    expect(option.yAxis[0]!.data).toEqual(['Diep', 'Licht', 'REM', 'Wakker'])
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

  it('say there is no usual yet for a figure the server sent no usual for', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, figures: { ...page.figures, rem: { ...page.figures.rem, baseline: null, standing: null, judged: null } } })
    expect(minis(host)[2]).toEqual(['REM', '2h 03m', 'no usual yet'])
  })

  it('colour each strip day dot by where the server said that day stood', async () => {
    const host = await mount(nightPageFixture())
    // Deep sleep's last night (64 minutes) sits below its usual 70-100: its dot takes the warning colour.
    const chart = host.querySelector<HTMLDivElement>('.night-minis [role="img"][aria-label="Deep sleep"]')!
    const option = echarts.getInstanceByDom(chart)?.getOption() as { series: { data: ({ itemStyle?: { color?: string } } | null)[] }[] }
    const dots = option.series.find((s) => Array.isArray(s.data) && s.data.some((d) => d !== null && typeof d === 'object' && 'itemStyle' in d))!
    expect(dots.data.at(-1)?.itemStyle?.color).toBe(NEGATIVE)
    expect(dots.data[0]?.itemStyle?.color).not.toBe(NEGATIVE)
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
    // Naps are the More card's to say, not this one's.
    expect(card?.querySelector('.night-naps')).toBeNull()
    expect(card?.textContent).not.toContain('No naps recorded')
  })

  it('describes the hypnogram by its legend', async () => {
    const host = await mount(nightPageFixture())
    const chart = host.querySelector('[role="img"][aria-label="The night"]')!
    const describedBy = chart.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Deep 1h 04m · 16 %Light 3h 29m · 53 %REM 2h 03m · 31 %Awake 0h 25m')
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

  // A device that recorded a span but no stages leaves nothing for a hypnogram to draw, and an
  // empty chart would claim a night with no deep, light or REM sleep in it - so the chart and its
  // legend are absent. With no traces either (this file's stub answers every trace empty), the
  // card has nothing left to say and closes up (from night-stages.test.tsx, moved here with
  // NightStages).
  it('draws no hypnogram when the night carries no staged segments', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, night: { ...page.night, segments: [] } })
    expect(host.querySelector('.night-legend')).toBeNull()
    expect(host.querySelector('[role="img"][aria-label="The night"]')).toBeNull()
  })

  // ASLEEP and RESTLESS are recognised by the derive layer and staged by nobody; a segment carrying
  // either drops out rather than being drawn as light sleep (from night-stages.test.tsx).
  it('drops a segment nobody staged rather than drawing it as light sleep', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      night: {
        ...page.night,
        segments: [
          { stage: 'DEEP', startMs: page.night.startMs, endMs: page.night.startMs + 60 * 60_000 },
          { stage: 'RESTLESS', startMs: page.night.startMs + 60 * 60_000, endMs: page.night.startMs + 70 * 60_000 },
        ],
      },
    })
    expect([...host.querySelectorAll('.night-legend li')].map((item) => item.textContent)).toEqual(['Deep 1h 00m · 16 %'])
  })
})

describe('the night page\'s week', () => {
  it('draws the week\'s bed and wake times in the schedule card, and how much bedtime varied', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('[aria-label="Sleep schedule"]')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('Sleep schedule')
    expect(card?.querySelectorAll('tbody tr')).toHaveLength(7)
    expect(text(card!, '.night-week-variability')).toBe('Bedtime varied ±28 min this week · usually ±20–35 min')
  })

  // The bars are the seven nights' bed and wake placed on the chart's own axis: bed shifted past
  // the axis's noon into the evening frame (-20, 23:40, is 1420) and wake that plus the night's
  // length, so a bar never runs backwards and never falls outside the window drawn.
  it('draws a bar from bed to wake for each of the seven nights, inside the axis', async () => {
    const host = await mount(nightPageFixture())
    const chart = host.querySelector<HTMLDivElement>('[role="img"][aria-label="Sleep schedule"]')!
    const option = echarts.getInstanceByDom(chart)?.getOption() as {
      series: { type: string, data: number[][], markArea?: { data: { yAxis: number }[][] } }[]
      yAxis: { min: number, max: number }[]
    }
    const bars = option.series.find((s) => s.type === 'custom')!
    expect(bars.data.map(([, bed, wake]) => [bed, wake])).toEqual([
      [1420, 1822], [1430, 1866], [1445, 1831], [1415, 1835], [1470, 1838], [1425, 1886], [1448, 1869],
    ])
    const { min, max } = option.yAxis[0]!
    for (const [, bed, wake] of bars.data) {
      expect(bed).toBeGreaterThanOrEqual(min)
      expect(wake).toBeLessThanOrEqual(max)
    }
    // The usual bed (23:30-00:20) and wake (06:30-07:30) bands, in the same frame as the bars.
    expect(bars.markArea?.data.map(([from, to]) => [from!.yAxis, to!.yAxis])).toEqual([[1410, 1460], [1830, 1890]])
  })

  it('draws no usual bands on the schedule when the usual is thin', async () => {
    const page = nightPageFixture()
    const thin = (f: typeof page.figures.bedtime) => ({ ...f, baseline: { ...f.baseline!, thin: true }, standing: null, judged: null })
    const host = await mount({ ...page, figures: { ...page.figures, bedtime: thin(page.figures.bedtime), waketime: thin(page.figures.waketime) } })
    const chart = host.querySelector<HTMLDivElement>('[role="img"][aria-label="Sleep schedule"]')!
    const option = echarts.getInstanceByDom(chart)?.getOption() as { series: { type: string, markArea?: { data?: unknown[] } }[] }
    expect(option.series.find((s) => s.type === 'custom')?.markArea?.data ?? []).toEqual([])
  })

  it('describes the schedule chart by its variability line', async () => {
    const host = await mount(nightPageFixture())
    const describedBy = host.querySelector('[role="img"][aria-label="Sleep schedule"]')!.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Bedtime varied ±28 min this week · usually ±20–35 min')
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
    // The balance card, its neighbour in the same row, takes the whole row rather than leaving half of it empty.
    expect(host.querySelector('[aria-label="Sleep balance"]')?.closest('.card')?.getAttribute('data-span')).toBe('12')
  })

  it('hides the balance card when no night of the week has a balance, and the schedule takes the row', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page, balance: { ...page.balance, nights: page.balance.nights.map((n) => ({ ...n, difference: null })), total: 0 },
    })
    expect(host.querySelector('[aria-label="Sleep balance"]')).toBeNull()
    expect(host.querySelector('[aria-label="Sleep schedule"]')?.closest('.card')?.getAttribute('data-span')).toBe('12')
  })

  it('sits the two cards side by side when both have something to draw', async () => {
    const host = await mount(nightPageFixture())
    expect(host.querySelector('[aria-label="Sleep schedule"]')?.closest('.card')?.getAttribute('data-span')).toBe('6')
    expect(host.querySelector('[aria-label="Sleep balance"]')?.closest('.card')?.getAttribute('data-span')).toBe('6')
  })

  it('totals the week\'s balance, signed, against the target it was drawn from', async () => {
    const host = await mount(nightPageFixture())
    const card = host.querySelector('[aria-label="Sleep balance"]')?.closest('.card')
    expect(card?.querySelector('.label')?.textContent).toBe('Sleep balance')
    expect(text(card!, '.night-week-total')).toBe('-7h 24m')
    expect(card?.textContent).toContain('against your target of 7h 30m')
    expect(text(card!, '.night-week-bars-caption')).toBe('each bar: that night against your target')
    expect(card?.querySelectorAll('tbody tr')).toHaveLength(7)
    const describedBy = card!.querySelector('[role="img"]')!.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('-7h 24m against your target of 7h 30m')
  })

  it('signs a week ahead of its target with a plus', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, balance: { ...page.balance, total: 26 } })
    expect(text(host, '.night-week-total')).toBe('+26m')
  })

  it('words the balance in Dutch against the target', async () => {
    const host = await mount(nightPageFixture(), 'nl')
    expect(text(host, '.night-week-against')).toBe('ten opzichte van je doel van 7h 30m')
    expect(text(host, '.night-week-bars-caption')).toBe('elke balk: die nacht tegenover je doel')
  })

  it('words the balance in Dutch against the usual', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, balance: { ...page.balance, zeroLine: { minutes: 400, source: 'baseline' } } }, 'nl')
    expect(text(host, '.night-week-against')).toBe('ten opzichte van je gebruikelijke 6h 40m')
    expect(text(host, '.night-week-bars-caption')).toBe('elke balk: die nacht tegenover je gebruikelijke')
  })

  it('names the usual instead of a target when the zero line is the baseline', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, balance: { ...page.balance, zeroLine: { minutes: 400, source: 'baseline' } } })
    const card = host.querySelector('[aria-label="Sleep balance"]')?.closest('.card')
    expect(card?.textContent).toContain('against your usual 6h 40m')
    expect(text(card!, '.night-week-bars-caption')).toBe('each bar: that night against your usual')
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

  it('draws the recovery ring with the index and its band, resting HR, HRV and skin temperature as strips, and breathing and oxygen as bars', async () => {
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
      // A deviation, so its usual is worded as one too: the band's edges less its centre.
      ['Skin temperature', '+0.6 °C', 'above your usual ±0.3 °C'],
    ])
    // Resting HR, HRV and skin temperature are the rows with a trend (a strip); breathing and
    // oxygen draw a bar instead, the spec's and the mockup's own split.
    expect(card.querySelectorAll('[role="img"][aria-label="Resting HR"]')).toHaveLength(1)
    // Named for when, since the night card above draws an HRV chart of its own.
    expect(card.querySelectorAll('[role="img"][aria-label="HRV this morning"]')).toHaveLength(1)
    expect(card.querySelectorAll('[role="img"][aria-label="Skin temperature"]')).toHaveLength(1)
    expect(card.querySelectorAll('.figure-row-bar')).toHaveLength(2)
  })

  it('lays the readings out three across', async () => {
    // Root-relative: happy-dom gives import.meta.url an http scheme, so a URL-relative path cannot be read.
    const css = readFileSync('apps/web/src/app.css', 'utf8')
    expect(css).toMatch(/\.night-morning-rows \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  })

  it('colours the skin temperature strip\'s warm nights by where the server said they stood', async () => {
    const host = await mount(nightPageFixture())
    const chart = host.querySelector<HTMLDivElement>('.night-grp [role="img"][aria-label="Skin temperature"]')!
    const option = echarts.getInstanceByDom(chart)?.getOption() as { series: { data: ({ itemStyle?: { color?: string } } | null)[] }[] }
    const dots = option.series.find((s) => Array.isArray(s.data) && s.data.some((d) => d !== null && typeof d === 'object' && 'itemStyle' in d))!
    // 33.4 and 33.6 sit above the 32.7-33.3 usual; 33.0 does not.
    expect(dots.data.slice(-2).map((d) => d?.itemStyle?.color)).toEqual([NEGATIVE, NEGATIVE])
    expect(dots.data[0]?.itemStyle?.color).not.toBe(NEGATIVE)
  })

  it('words an uneven skin temperature usual as its two signed edges', async () => {
    const page = nightPageFixture()
    const skin = { ...page.morning.skinTemperature, baseline: { center: 33, low: 32.8, high: 33.3, thin: false } }
    const host = await mount({ ...page, morning: { ...page.morning, skinTemperature: skin } })
    const row = [...host.querySelectorAll('.night-grp .figure-row')].at(-1)!
    expect(text(row, '.figure-row-verdict')).toBe('above your usual -0.2 °C – +0.3 °C')
  })

  it('falls back to the skin temperature reading itself when there is no deviation to show', async () => {
    const page = nightPageFixture()
    const skin = { ...page.morning.skinTemperature, baseline: { center: 33, low: 32.7, high: 33.3, thin: true }, standing: null, judged: null }
    const host = await mount({ ...page, morning: { ...page.morning, skinTemperature: skin, skinTemperatureDeviation: null } })
    const row = [...host.querySelectorAll('.night-grp .figure-row')].at(-1)!
    expect(text(row, '.figure-row-value')).toBe('33.6 °C')
    expect(text(row, '.figure-row-verdict')).toBe('not enough history for a usual yet')
    expect(row.textContent).not.toContain('— °C')
  })

  it('gives the recovery index its usual and what it is made of', async () => {
    const page = nightPageFixture()
    const recovery = page.morning.recovery
    const index = { ...recovery.index, baseline: { center: 66, low: 55, high: 78, thin: false }, standing: 'within' as const }
    const host = await mount({ ...page, morning: { ...page.morning, recovery: { ...recovery, index } } })
    const dial = host.querySelector('.night-grp .dash-dial')!
    expect(text(dial, '.night-recovery-usual')).toBe('within your usual 55 – 78')
    expect(text(dial, '.night-recovery-from')).toBe('from HRV, resting heart rate, breathing, sleep and bedtime')
  })

  it('leaves an input the index went without out of what it is made of', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, morning: { ...page.morning, recovery: { ...page.morning.recovery, missing: ['hrv'] } } })
    expect(text(host, '.night-recovery-from')).toBe('from resting heart rate, breathing, sleep and bedtime')
  })

  it('says there is no usual to compare against rather than leaving a row\'s hidden description empty', async () => {
    const page = nightPageFixture()
    const host = await mount({
      ...page,
      morning: { ...page.morning, restingHeartRate: { ...page.morning.restingHeartRate, baseline: null, standing: null, judged: null } },
    })
    const card = host.querySelector('.night-grp')?.closest('.card')!
    expect(text(card, '.figure-row-verdict')).toBe('no usual yet')
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
      ['Time to fall asleep', '12 min', 'within your usual 5 min – 20 min'],
      ['Times woken', '14', 'within your usual 8 – 18'],
      ['Minutes after waking', '4 min', 'within your usual 0 min – 10 min'],
      ['Naps', 'none', 'within your usual 0 – 1'],
    ])
    expect(card.querySelectorAll('.figure-row-bar')).toHaveLength(rows.length)
  })

  it('words a usual that is one value rather than a range as that value', async () => {
    const page = nightPageFixture()
    const napCount = { ...page.figures.napCount, baseline: { center: 0, low: 0, high: 0, thin: false } }
    const host = await mount({ ...page, figures: { ...page.figures, napCount } })
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('.label')?.textContent === 'More about the sleep')!
    expect(text(card, '.figure-row:last-child .figure-row-verdict')).toBe('usually 0')
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
    expect(card.querySelector('.day-log-mood [aria-hidden="true"]')).not.toBeNull()
    expect(card.querySelector('.day-log-mood-word')?.textContent).toBe('Good')
    // The fixture's only counted kind, alcohol, was tapped twice, so its chip carries the count;
    // a chip for a kind tapped once would carry none (the brief's own "count shown when > 1").
    expect([...card.querySelectorAll('.day-log-chip')].map((chip) => chip.textContent)).toEqual(['Alcohol ×2'])
    expect(card.querySelector('.day-log-note')?.textContent).toBe('“Birthday, home late.”')
    const rows = [...card.querySelectorAll('.figure-row')].map((row) => [
      text(row, '.figure-row-label') ?? '', text(row, '.figure-row-value') ?? '',
    ])
    expect(rows[0]).toEqual(['Steps', '11,240'])
    expect(rows[1]).toEqual(['Active minutes', '48 min'])
    expect(text(card, '.figure-row:nth-child(2) .figure-row-verdict')).toBe('within your usual 25 min – 60 min')
    expect(rows[2]?.[0]).toBe('Training')
    const workoutLink = card.querySelector<HTMLAnchorElement>('.day-workout-link')
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
    expect([...card.querySelectorAll('.day-log-chip')].map((chip) => chip.textContent)).toEqual(['Alcohol'])
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
    // The one line that says what is folded away, in place of the long basis sentence.
    expect(text(card, '.night-about-line')).toBe('One recording from watch · no naps · exclude or add a note')
    expect(card.querySelector('.basis')).toBeNull()
  })

  it('counts the recordings and the naps in its line', async () => {
    const page = nightPageFixture()
    const host = await mount({ ...page, night: { ...page.night, sessionIds: ['s1', 's2'], naps: [Date.UTC(2026, 8, 6, 12, 30)] } })
    expect(text(host, '.night-about-line')).toBe('2 recordings from watch · one nap · exclude or add a note')
  })
})

describe('the night page\'s charts', () => {
  // Every chart on the page has a name and a description that resolves to words; the recovery
  // ring alone carries its whole statement in its own aria-label.
  it('each point at a description that says something', async () => {
    const host = await mount(nightPageFixture())
    const charts = [...host.querySelectorAll('.night-page [role="img"]')].filter((el) => !el.classList.contains('score-ring'))
    expect(charts.length).toBeGreaterThan(0)
    for (const chart of charts) {
      const id = chart.getAttribute('aria-describedby')
      expect(id, chart.getAttribute('aria-label') ?? '').not.toBeNull()
      expect(document.getElementById(id!)?.textContent?.trim(), chart.getAttribute('aria-label') ?? '').toBeTruthy()
    }
  })
})

describe('the night page without a night', () => {
  it('says no night was recorded on a date the server has none for', async () => {
    const host = await mount(null)
    expect(host.innerHTML).toContain('No night recorded')
    expect(host.querySelector('.night-page')).toBeNull()
  })

  it('offers a retry, not "no night", when the read fails for any other reason', async () => {
    const host = await mount(null, 'en', { status: 500, body: { error: { code: 'internal', message: 'boom' } } })
    expect(host.innerHTML).not.toContain('No night recorded')
    expect(host.querySelector('button')?.textContent).toBe('Try again')
    expect(host.querySelector('.night-page')).toBeNull()
  })
})
