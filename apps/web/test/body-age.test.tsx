// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BodyAge } from '../src/pages/BodyAge.js'
import { Sidebar } from '../src/components/Sidebar.js'
import { I18nProvider } from '../src/i18n/index.js'
import { addDays, localToday } from '../src/controls/range.js'
import type { BodyAgeAvailable, BodyAgeRead } from '../src/data/useBodyAge.js'
import { PERSON, withQuery } from './sleepPageStub.js'
import { flush } from './flush.js'
import { dayTableRows } from '../src/charts/base.js'
import { dayTooltip } from '../src/charts/dayTooltip.js'

// The trend strip, stubbed so a test can read what it was handed (recovery.test.tsx's idiom).
type SparklineProps = {
  label: string, values: (number | null)[], reference?: { values: (number | null)[], label: string }
  baseline?: { low: number, high: number }, bandLabels?: { low: string, high: string }
}
const { sparklines } = vi.hoisted(() => ({ sparklines: new Map<string, SparklineProps>() }))
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: SparklineProps) => {
    sparklines.set(props.label, props)
    return <div data-sparkline={props.label} />
  },
}))

// The person's today, as the page reads it: the session's zone, the real clock.
const TODAY = localToday(PERSON.effectiveTimezone)
const EARLIER = addDays(TODAY, -14)

const METHOD: BodyAgeRead['method'] = {
  windowDays: 30, vo2LookbackDays: 180, minFactorDays: 10, gompertzSlope: 0.085, totalCap: 10,
  factors: [
    { key: 'vo2Max', unit: 'ml/kg/min', cap: 6, citation: 'Kodama et al. 2009.' },
    { key: 'restingHeartRate', unit: 'bpm', cap: 3, citation: 'Zhang, Shen & Qi 2016.' },
    { key: 'activity', unit: 'min/week', cap: 2.5, citation: 'Arem et al. 2015.' },
    { key: 'sleepRegularity', unit: 'min', cap: 3.5, citation: 'Windred et al. 2024.' },
    { key: 'strength', unit: 'sessions/week', cap: 2, citation: 'Momma et al. 2022.' },
  ],
}

const CURRENT: BodyAgeAvailable = {
  enough: true, endDate: TODAY, window: { from: addDays(TODAY, -29), to: TODAY },
  calendarAge: 38.4, bodyAge: 34.6, gap: -3.8, totalCapped: false,
  factors: [
    { key: 'vo2Max', value: 47.2, reference: 42.4, years: -3, capped: false, days: 1, missing: null },
    { key: 'restingHeartRate', value: 54, reference: 62, years: -0.9, capped: false, days: 28, missing: null },
    { key: 'activity', value: 186, reference: 150, years: -0.5, capped: false, days: 30, missing: null },
    { key: 'sleepRegularity', value: 74, reference: 51, years: 0.6, capped: false, days: 26, missing: null },
    { key: 'strength', value: 0, reference: 0, years: 0, capped: false, days: 30, missing: null },
  ],
  carriedBy: 'vo2Max', mostRoom: { key: 'sleepRegularity', years: 0.6 }, fitnessAge: 35, vo2MaxDate: addDays(TODAY, -3),
}

const FULL: BodyAgeRead = {
  current: CURRENT,
  previous: { ...CURRENT, bodyAge: 35, gap: -3.4 },
  months: [
    { month: '2026-07', endDate: '2026-07-31', bodyAge: 33.6, calendarAge: 38.2, gap: -4.6 },
    { month: '2026-08', endDate: '2026-08-31', bodyAge: 34.4, calendarAge: 38.3, gap: -3.9 },
    { month: '2026-09', endDate: '2026-09-30', bodyAge: 34.6, calendarAge: 38.4, gap: -3.8 },
  ],
  pace: 0.72,
  youngest: { month: '2026-07', endDate: '2026-07-31', bodyAge: 33.6, calendarAge: 38.2, gap: -4.6 },
  method: METHOD,
}

const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function stub(urls: string[], read: BodyAgeRead, status?: number): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/body-age')) return status === undefined ? json(read) : json({ error: 'refused' }, status)
    if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    return json({ items: [] })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let restore: () => void = () => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sparklines.clear()
})

afterEach(() => {
  act(() => { root?.unmount() })
  restore()
  restore = () => {}
  container?.remove()
  container = null
  root = null
})

async function render(read: BodyAgeRead, lng = 'en', status?: number): Promise<string[]> {
  act(() => { root?.unmount() })
  root = createRoot(container!)
  window.history.replaceState(null, '', '/body-age')
  const urls: string[] = []
  restore()
  restore = stub(urls, read, status)
  const { client, tree } = withQuery(<BodyAge />)
  act(() => { root?.render(<I18nProvider lng={lng}>{tree}</I18nProvider>) })
  await flush(client, () => container!.innerHTML)
  return urls
}

const cardFor = (label: string): HTMLElement | undefined => [...container!.querySelectorAll<HTMLElement>('section.card')]
  .find((card) => card.querySelector(':scope > .label')?.textContent === label)
const heroLines = (): string[] => [...cardFor('Body age, last 30 days')!.querySelectorAll('.workout-hero-line')].map((line) => line.textContent ?? '')
const read = (patch: Partial<BodyAgeRead>): BodyAgeRead => ({ ...FULL, ...patch })
const current = (patch: Partial<BodyAgeAvailable>): BodyAgeRead => read({ current: { ...CURRENT, ...patch } })

describe('the body age page', () => {
  it('draws the header, the hero, what moves it and how it is worked out from one read', async () => {
    const urls = await render(FULL)
    expect(urls.filter((url) => url.includes('/api/v1/p/p1/body-age'))).toHaveLength(1)
    expect(container!.querySelector('h1')?.textContent).toBe('Body age')
    expect(container!.querySelector('.dash-date')?.textContent).toBe('Last 30 days')
    // No control row: the window is fixed.
    expect(container!.querySelector('.control-row')).toBeNull()
    const labels = [...container!.querySelectorAll('section.card > .label')].map((label) => label.textContent)
    expect(labels).toEqual(['Body age, last 30 days', 'What moves it', 'How it\'s worked out'])

    const hero = cardFor('Body age, last 30 days')!
    expect(hero.querySelector('.dash-headline')?.textContent).toBe('34.6')
    const verdict = hero.querySelector('.detail-verdict')!
    expect(verdict.textContent).toBe('3.8 years younger than your calendar age of 38.4')
    expect(verdict.classList.contains('better')).toBe(true)
    expect(heroLines()).toEqual([
      'ageing 0.72 years per year over the last 12 months',
      '-0.4 against the 30 days before',
      'youngest: 4.6 years younger, in July 2026',
      'mostly down to your VO₂max',
    ])
    // The strip: a point per month, the calendar age as its reference line.
    const strip = sparklines.get('Body age')!
    expect(strip.values).toEqual([33.6, 34.4, 34.6])
    expect(strip.reference?.values).toEqual([38.2, 38.3, 38.4])
    // Labelled at its left edge with the range both lines span, as every hero strip's band is.
    expect(strip.baseline).toEqual({ low: 33.6, high: 38.4 })
    expect(strip.bandLabels).toEqual({ low: '33.6', high: '38.4' })
  })

  it('words each factor, its comparison, its toned years, and the most room', async () => {
    await render(FULL)
    const card = cardFor('What moves it')!
    const rows = [...card.querySelectorAll('.body-age-factor')]
    expect(rows.map((row) => row.querySelector('.label')?.textContent))
      .toEqual(['VO₂max', 'Resting heart rate', 'Active minutes', 'Bedtime variability', 'Strength training'])
    const vo2 = rows[0]!
    expect(vo2.querySelector('.figure-row-value')?.textContent).toBe('47.2 ml/kg/min')
    expect(vo2.querySelector('.body-age-factor-note')?.textContent).toBe('above your age\'s average of 42.4 · fitness age 35.0')
    expect(vo2.querySelector('.body-age-factor-years')?.textContent).toBe('-3.0 years')
    expect(vo2.querySelector('.body-age-factor-years')?.classList.contains('better')).toBe(true)
    // A younger factor fills left of the centre, scaled to its own cap: 3 of 6 is half of one side.
    expect((vo2.querySelector('.diverging-bar-fill') as HTMLElement).style.width).toBe('25%')
    const sleep = rows[3]!
    expect(sleep.querySelector('.body-age-factor-years')?.textContent).toBe('+0.6 years')
    expect(sleep.querySelector('.body-age-factor-years')?.classList.contains('worse')).toBe(true)
    const strength = rows[4]!
    expect(strength.querySelector('.body-age-factor-years')?.textContent).toBe('0.0 years')
    expect(strength.querySelector('.body-age-factor-years')?.classList.contains('better')).toBe(false)
    expect(strength.querySelector('.body-age-factor-years')?.classList.contains('worse')).toBe(false)
    expect(card.querySelector('.body-age-room')?.textContent)
      .toBe('Most room: bedtime variability. At your age\'s typical level it would count about 0.6 years fewer.')
  })

  it('builds how it is worked out from the method alone', async () => {
    await render(FULL)
    const prose = cardFor('How it\'s worked out')!.textContent ?? ''
    expect(prose).toContain('last 30 days')
    expect(prose).toContain('0.085')
    expect(prose).toContain('VO₂max, up to 6 years.')
    // The studies sit behind one Sources disclosure, closed until the reader opens it.
    const sources = cardFor('How it\'s worked out')!.querySelectorAll('details')
    expect(sources).toHaveLength(1)
    expect(sources[0]!.open).toBe(false)
    expect(sources[0]!.querySelector('summary')?.textContent).toBe('Sources')
    expect([...sources[0]!.querySelectorAll('.body-age-citation')].map((p) => p.textContent))
      .toEqual(['VO₂max: Kodama et al. 2009.', 'Resting heart rate: Zhang, Shen & Qi 2016.', 'Active minutes: Arem et al. 2015.',
        'Bedtime variability: Windred et al. 2024.', 'Strength training: Momma et al. 2022.'])
    expect(prose).toContain('An estimate from published associations, not a measurement of your cells.')
  })

  it('hides the pace, the change, the youngest, the carrier and the most room when each is missing', async () => {
    await render(read({ pace: null, previous: null, youngest: null, current: { ...CURRENT, carriedBy: null, mostRoom: null } }))
    expect(heroLines()).toEqual([])
    expect(cardFor('What moves it')!.querySelector('.body-age-room')).toBeNull()
    // A youngest month that was not younger says nothing either.
    await render(read({ youngest: { ...FULL.youngest!, gap: 0.4 } }))
    expect(heroLines().some((line) => line.startsWith('youngest'))).toBe(false)
  })

  it('dates the window in the header when it does not end today', async () => {
    await render(current({ endDate: EARLIER, window: { from: addDays(EARLIER, -29), to: EARLIER } }))
    const day = new Date(`${EARLIER}T00:00:00Z`).toLocaleString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    expect(container!.querySelector('.dash-date')?.textContent).toBe(`Last 30 days, to ${day}`)
  })

  it('sets strength training against a reference of none', async () => {
    await render(current({ factors: CURRENT.factors.map((factor) => factor.key === 'strength' ? { ...factor, value: 1, years: -1.2 } : factor) }))
    const strength = [...cardFor('What moves it')!.querySelectorAll('.body-age-factor')][4]!
    expect(strength.querySelector('.body-age-factor-note')?.textContent).toBe('against a reference of none')
    await render(current({ factors: CURRENT.factors.map((factor) => factor.key === 'strength' ? { ...factor, value: 1, years: -1.2 } : factor) }), 'nl')
    const sterkte = [...cardFor('Wat het beweegt')!.querySelectorAll('.body-age-factor')][4]!
    expect(sterkte.querySelector('.body-age-factor-note')?.textContent).toBe('tegenover een referentie van geen')
    expect(cardFor('Wat het beweegt')!.querySelector('.body-age-room')?.textContent)
      .toBe('Meeste ruimte: variatie in bedtijd. Op het typische niveau voor je leeftijd zou het ongeveer 0,6 jaar minder tellen.')
  })

  it('says why a factor does not count', async () => {
    await render(current({
      factors: CURRENT.factors.map((factor) => factor.key === 'restingHeartRate'
        ? { ...factor, value: null, reference: 62, years: 0, days: 0, missing: 'noReading' as const }
        : factor.key === 'activity' ? { ...factor, value: null, years: 0, days: 6, missing: 'tooFewDays' as const } : factor),
    }))
    const rows = [...cardFor('What moves it')!.querySelectorAll('.body-age-factor')]
    expect(rows[1]!.querySelector('.body-age-factor-note')?.textContent).toBe('No resting heart rate in the last 30 days')
    expect(rows[1]!.querySelector('.body-age-factor-years')).toBeNull()
    expect(rows[2]!.querySelector('.body-age-factor-note')?.textContent).toBe('Only 6 days of active minutes, 10 needed')
  })

  it('keeps the header over a failed read, and over no body age says so', async () => {
    await render(FULL, 'en', 500)
    expect(container!.querySelector('h1')?.textContent).toBe('Body age')
    expect(container!.querySelector('.empty .button')?.textContent).toBe('Try again')
    await render(read({ current: null, previous: null, months: [], pace: null, youngest: null }))
    expect(container!.querySelector('h1')?.textContent).toBe('Body age')
    expect(container!.querySelectorAll('section.card')).toHaveLength(1)
    expect(container!.querySelector('.empty')).not.toBeNull()
  })
})

describe('the body age page, unavailable', () => {
  const unavailable = (missing: ('birthDate' | 'sex' | 'vo2Max')[]): BodyAgeRead =>
    read({ current: { enough: false, endDate: TODAY, missing }, previous: null, months: [], pace: null, youngest: null })
  const reason = () => [...container!.querySelectorAll('section.card p')].map((p) => p.textContent)

  it.each([
    ['en', ['birthDate'], 'Add your birth date and sex in Settings to see your body age'],
    ['en', ['sex'], 'Add your birth date and sex in Settings to see your body age'],
    ['en', ['vo2Max'], 'No VO₂max reading in the last 6 months'],
    ['nl', ['birthDate', 'sex'], 'Vul je geboortedatum en geslacht in bij Instellingen om je lichaamsleeftijd te zien'],
    ['nl', ['vo2Max'], 'Geen VO₂max-meting in de afgelopen 6 maanden'],
  ] as const)('in %s, missing %j, says so in one card', async (lng, missing, sentence) => {
    await render(unavailable([...missing]), lng)
    expect(container!.querySelectorAll('section.card')).toHaveLength(1)
    expect(reason()).toEqual([sentence])
  })

  it('links the settings sentence to Settings', async () => {
    await render(unavailable(['birthDate', 'vo2Max']))
    expect(reason()).toEqual(['Add your birth date and sex in Settings to see your body age', 'No VO₂max reading in the last 6 months'])
    expect(container!.querySelector('section.card a')?.getAttribute('href')).toBe('/settings')
  })
})

describe('the rail', () => {
  it('lists Body age between Recovery and Health', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<I18nProvider lng="en"><Sidebar person="Wilma" active="/" onSignOut={() => {}} /></I18nProvider>)
    const hrefs = [...host.querySelectorAll('.rail-item')].map((item) => item.getAttribute('href'))
    const at = hrefs.indexOf('/body-age')
    expect(at).toBeGreaterThan(0)
    expect(hrefs.slice(at - 1, at + 2)).toEqual(['/recovery', '/body-age', '/health'])
  })
})

// Sparkline is stubbed above, so its reference line is checked where it reaches a reader in words:
// the accessible table's column and the tooltip's line, both built outside the chart.
describe('the strip\'s reference line', () => {
  const t = ((key: string, params?: Record<string, string>) => (key === 'charts.tooltip.line' ? `${params!.label}: ${params!.value}` : key)) as never
  const format = (value: number | null, absent: string) => (value === null ? absent : String(value))

  it('gets a column of its own in the accessible table', () => {
    const rows = dayTableRows({ values: [34.4, 34.6], labels: ['2026-08-31', '2026-09-30'], excluded: [], annotations: [], format, t, reference: [38.3, 38.4] })
    expect(rows.map((row) => row.slice(0, 3))).toEqual([['2026-08-31', '34.4', '38.3'], ['2026-09-30', '34.6', '38.4']])
  })

  it('gets a line of its own in the tooltip, under its label', () => {
    const html = dayTooltip({
      values: [34.4, 34.6], labels: ['2026-08-31', '2026-09-30'], excluded: [], annotations: [], marks: { atValue: [], atDate: [] },
      trend: undefined, hasTrend: false, episodic: false, unit: 'Body age', format, t,
      reference: { values: [38.3, 38.4], label: 'Calendar age' },
    }, { componentType: 'series', dataIndex: 1 })
    expect(html.split('<br/>')).toEqual(['2026-09-30', 'Body age: 34.6', 'Calendar age: 38.4'])
  })
})
