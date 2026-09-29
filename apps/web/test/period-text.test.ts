import { describe, it, expect } from 'vitest'
import {
  dayCountsLine, periodStripOf, periodValueLine, periodVerdictLine, standoutLine, windowPhrase,
} from '../src/pages/detail/periodText.js'
import type { PeriodChange, PeriodFigure, PeriodStripPoint, PeriodWindow } from '../src/data/periodTypes.js'
import type { Translate } from '../src/format.js'
import { initI18n } from '../src/i18n/index.js'

// The real catalogues through a real i18next instance, as figure-text.test.ts does: the page reads
// what nl.json actually says, not what a stub believes it says. Synthetic figures throughout.
function tFor(language: 'en' | 'nl'): Translate {
  const instance = initI18n(language)
  return (key, options) => instance.t(key, options)
}

const t = tFor('en')
const tNl = tFor('nl')
const NB = ' '

const MONTH: PeriodWindow = { unit: 'month', count: 12, from: '2025-08-01', to: '2026-07-31' }

function figure(overrides: Partial<PeriodFigure> = {}): PeriodFigure {
  return {
    metric: 'sleep_asleep_minutes', unit: 'minutes', precision: 0, direction: 'up', per: 'day',
    value: 420, total: null, days: 30,
    usual: { center: 430, low: 410, high: 450, thin: false, window: MONTH, periods: 12 },
    standing: 'within', judged: null, reason: null,
    counts: { within: 24, above: 3, below: 3, unjudged: 0 },
    daily: [], weekly: null, ...overrides,
  }
}

function point(from: string, value: number | null, o: Partial<PeriodStripPoint> = {}): PeriodStripPoint {
  return { from, to: from, value, band: null, standing: null, judged: null, days: value === null ? 0 : 1, ...o }
}

const NO_CHANGE: PeriodChange = { from: '2026-07-01', to: '2026-07-31', value: null, delta: null }

describe('windowPhrase', () => {
  it('names each window length in both languages', () => {
    expect(windowPhrase({ unit: 'week', count: 12, from: '2026-05-04', to: '2026-07-26' }, t)).toBe('for a week, last 12 weeks')
    expect(windowPhrase(MONTH, t)).toBe('for a month, last 12 months')
    expect(windowPhrase({ unit: 'quarter', count: 4, from: '2025-05-01', to: '2026-04-30' }, t))
      .toBe('for 3 months, last 4 periods of 3 months')
    expect(windowPhrase({ unit: 'week', count: 12, from: '2026-05-04', to: '2026-07-26' }, tNl)).toBe('voor een week, afgelopen 12 weken')
    expect(windowPhrase(MONTH, tNl)).toBe('voor een maand, afgelopen 12 maanden')
    expect(windowPhrase({ unit: 'quarter', count: 4, from: '2025-05-01', to: '2026-04-30' }, tNl))
      .toBe('voor 3 maanden, afgelopen 4 periodes van 3 maanden')
  })

  it('names a year by the year its usual comes from', () => {
    const year: PeriodWindow = { unit: 'year', count: 1, from: '2025-01-01', to: '2025-12-31' }
    expect(windowPhrase(year, t)).toBe('for a year, from 2025')
    expect(windowPhrase(year, tNl)).toBe('voor een jaar, uit 2025')
  })
})

describe('periodVerdictLine', () => {
  it('words a month within its usual, then names the window', () => {
    const f = figure({ usual: { center: 430, low: 410, high: 450, thin: false, window: MONTH, periods: 12 } })
    expect(periodVerdictLine(f, 'en', t)).toBe(`within your usual 6h${NB}50m – 7h${NB}30m · for a month, last 12 months`)
    expect(periodVerdictLine(f, 'nl', tNl))
      .toBe(`binnen je gebruikelijke bereik 6u${NB}50m – 7u${NB}30m · voor een maand, afgelopen 12 maanden`)
  })

  it('words a bedtime above its usual as later', () => {
    const f = figure({
      metric: 'sleep_bedtime_minutes', unit: 'minutes_from_local_midnight', direction: 'neutral', value: -20,
      usual: { center: -60, low: -75, high: -45, thin: false, window: MONTH, periods: 12 }, standing: 'above',
    })
    expect(periodVerdictLine(f, 'en', t)).toBe('later than your usual 22:45 – 23:15 · for a month, last 12 months')
  })

  it('names the year its usual comes from on a year', () => {
    const f = figure({ usual: { center: 430, low: 410, high: 450, thin: false, periods: 4,
      window: { unit: 'year', count: 1, from: '2025-01-01', to: '2025-12-31' } } })
    expect(periodVerdictLine(f, 'en', t)).toBe(`within your usual 6h${NB}50m – 7h${NB}30m · for a year, from 2025`)
  })

  it('prints the reason, never a verdict', () => {
    expect(periodVerdictLine(figure({ reason: 'no-data', standing: null }), 'en', t)).toBeNull()
    expect(periodVerdictLine(figure({ reason: 'too-few-days', standing: null }), 'en', t)).toBe('too few days so far for a verdict')
    expect(periodVerdictLine(figure({ reason: 'too-few-days', standing: null }), 'nl', tNl)).toBe('nog te weinig dagen voor een oordeel')
    expect(periodVerdictLine(figure({ reason: 'thin-usual', standing: null }), 'en', t)).toBe('not enough history for a usual yet')
  })
})

describe('dayCountsLine', () => {
  it('counts a minutes figure\'s nights as longer and shorter', () => {
    const f = figure({ counts: { within: 24, above: 3, below: 2, unjudged: 1 } })
    expect(dayCountsLine(f, 'night', t)).toBe('24 of 30 nights usual · 3 longer · 2 shorter')
    expect(dayCountsLine(f, 'night', tNl)).toBe('24 van 30 nachten gebruikelijk · 3 langer · 2 korter')
  })

  it('counts a clock figure\'s nights as later and earlier', () => {
    const f = figure({ unit: 'minutes_from_local_midnight', counts: { within: 20, above: 4, below: 6, unjudged: 0 } })
    expect(dayCountsLine(f, 'night', t)).toBe('20 of 30 nights usual · 4 later · 6 earlier')
    expect(dayCountsLine(f, 'night', tNl)).toBe('20 van 30 nachten gebruikelijk · 4 later · 6 eerder')
  })

  it('counts any other figure\'s days as higher and lower', () => {
    const f = figure({ unit: 'bpm', counts: { within: 5, above: 1, below: 1, unjudged: 0 } })
    expect(dayCountsLine(f, 'day', t)).toBe('5 of 7 days usual · 1 higher · 1 lower')
    expect(dayCountsLine(f, 'day', tNl)).toBe('5 van 7 dagen gebruikelijk · 1 hoger · 1 lager')
  })

  it('leaves out the sides no day fell on, and says one night in the singular', () => {
    expect(dayCountsLine(figure({ counts: { within: 30, above: 0, below: 0, unjudged: 0 } }), 'night', t)).toBe('30 of 30 nights usual')
    expect(dayCountsLine(figure({ counts: { within: 1, above: 0, below: 0, unjudged: 0 } }), 'night', t)).toBe('1 of 1 night usual')
  })

  it('is null with no days, and with no day judged', () => {
    expect(dayCountsLine(figure({ counts: { within: 0, above: 0, below: 0, unjudged: 0 } }), 'night', t)).toBeNull()
    expect(dayCountsLine(figure({ counts: { within: 0, above: 0, below: 0, unjudged: 9 } }), 'day', t)).toBeNull()
  })
})

describe('standoutLine', () => {
  const previous: PeriodChange = { from: '2026-07-01', to: '2026-07-31', value: 397, delta: 23 }

  it('names a good high with ✦ and the change against the month before', () => {
    const o = { figure: figure(), high: { localDate: '2026-08-23', value: 501, good: true }, previous, yearEarlier: null, highWord: 'longest' as const }
    expect(standoutLine({ ...o, language: 'en', t })).toBe(`longest: 8h${NB}21m on Aug 23 ✦ · +0h${NB}23m against July`)
    expect(standoutLine({ ...o, language: 'nl', t: tNl })).toBe(`je langste: 8u${NB}21m op 23 aug ✦ · +0u${NB}23m tegenover juli`)
  })

  it('leaves the ✦ off a high that is not good', () => {
    const o = { figure: figure(), high: { localDate: '2026-08-23', value: 501, good: false }, previous: NO_CHANGE, yearEarlier: null, highWord: 'longest' as const }
    expect(standoutLine({ ...o, language: 'en', t })).toBe(`longest: 8h${NB}21m on Aug 23`)
  })

  it('adds the change against the same period a year earlier', () => {
    const o = {
      figure: figure(), high: null, previous: { ...previous, delta: -10 },
      yearEarlier: { from: '2025-08-01', to: '2025-08-31', value: 410, delta: 10 }, highWord: 'longest' as const,
    }
    expect(standoutLine({ ...o, language: 'en', t })).toBe(`-0h${NB}10m against July · +0h${NB}10m against last year`)
    expect(standoutLine({ ...o, language: 'nl', t: tNl })).toBe(`-0u${NB}10m tegenover juli · +0u${NB}10m tegenover vorig jaar`)
  })

  it('names the period before by its length', () => {
    const base = { figure: figure(), high: null, yearEarlier: null, highWord: 'busiest' as const, language: 'en', t }
    expect(standoutLine({ ...base, previous: { from: '2026-08-24', to: '2026-08-30', value: 400, delta: 5 } }))
      .toBe(`+0h${NB}05m against the week before`)
    expect(standoutLine({ ...base, previous: { from: '2026-04-01', to: '2026-06-30', value: 400, delta: 5 } }))
      .toBe(`+0h${NB}05m against the 3 months before`)
    expect(standoutLine({ ...base, previous: { from: '2025-01-01', to: '2025-12-31', value: 400, delta: 5 } }))
      .toBe(`+0h${NB}05m against 2025`)
    expect(standoutLine({ ...base, t: tNl, language: 'nl', previous: { from: '2026-08-24', to: '2026-08-30', value: 400, delta: 5 } }))
      .toBe(`+0u${NB}05m tegenover de week ervoor`)
  })

  it('words a busiest high and a non-duration difference', () => {
    const steps = figure({ metric: 'steps', unit: 'count' })
    expect(standoutLine({
      figure: steps, high: { localDate: '2026-08-02', value: 15000, good: true },
      previous: { from: '2026-07-01', to: '2026-07-31', value: 8000, delta: 450 }, yearEarlier: null,
      highWord: 'busiest', language: 'en', t,
    })).toBe('busiest: 15,000 on Aug 2 ✦ · +450 against July')
  })

  it('words a short span\'s change in minutes', () => {
    const active = figure({ metric: 'active_minutes', per: 'week' })
    expect(standoutLine({
      figure: active, high: null, previous: { from: '2026-07-01', to: '2026-07-31', value: 150, delta: -12 }, yearEarlier: null,
      highWord: 'busiest', language: 'en', t,
    })).toBe(`-12${NB}min against July`)
  })

  it('is null when nothing stood out', () => {
    expect(standoutLine({
      figure: figure(), high: null, previous: NO_CHANGE, yearEarlier: { ...NO_CHANGE }, highWord: 'longest', language: 'en', t,
    })).toBeNull()
  })
})

describe('periodStripOf', () => {
  const band = { center: 420, low: 400, high: 440, thin: false }

  it('draws the daily points, in stripOf\'s shape', () => {
    const f = figure({ daily: [
      point('2026-08-01', 410, { band, standing: 'within' }),
      point('2026-08-02', null),
      point('2026-08-03', 380, { band: { ...band, thin: true }, standing: 'below', judged: 'worse' }),
    ] })
    expect(periodStripOf(f)).toEqual({
      values: [410, null, 380],
      labels: ['2026-08-01', '2026-08-02', '2026-08-03'],
      bands: [{ low: 400, high: 440 }, null, null],
      pointStandings: ['within', null, 'below'],
      pointJudged: [null, null, 'worse'],
      weekly: false,
    })
  })

  it('draws the weekly points over the daily ones when there are both', () => {
    const f = figure({
      daily: [point('2026-08-01', 1), point('2026-08-02', 2)],
      weekly: [point('2026-07-27', 400, { to: '2026-08-02' }), point('2026-08-03', 420, { to: '2026-08-09' })],
    })
    expect(periodStripOf(f)).toEqual({
      values: [400, 420], labels: ['2026-07-27', '2026-08-03'], bands: undefined,
      pointStandings: [null, null], pointJudged: [null, null], weekly: true,
    })
  })

  it('is null below two points with a value', () => {
    expect(periodStripOf(figure({ daily: [point('2026-08-01', 410), point('2026-08-02', null)] }))).toBeNull()
    expect(periodStripOf(figure({ daily: [] }))).toBeNull()
  })
})

describe('periodValueLine', () => {
  it('prints a total with its per-day average under it', () => {
    const f = figure({ metric: 'distance', unit: 'meters', precision: 0, value: 5200, total: 156000 })
    expect(periodValueLine(f, 'en', t)).toEqual({ value: `156.00${NB}km`, under: `5.20${NB}km per day` })
    expect(periodValueLine(f, 'nl', tNl)).toEqual({ value: `156,00${NB}km`, under: `5,20${NB}km per dag` })
  })

  it('says per week under a per-week total', () => {
    const f = figure({ metric: 'active_minutes', unit: 'minutes', per: 'week', value: 150, total: 600 })
    expect(periodValueLine(f, 'en', t)).toEqual({ value: `600${NB}min`, under: `150${NB}min per week` })
  })

  it('prints the value alone for a figure with no total', () => {
    expect(periodValueLine(figure(), 'en', t)).toEqual({ value: `7h${NB}00m`, under: null })
  })
})
