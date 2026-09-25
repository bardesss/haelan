import { describe, it, expect } from 'vitest'
import { formatFigure, usualLine, asOfLine, paceKey, greetingKey } from '../src/pages/dashboard/glanceText.js'
import { initI18n } from '../src/i18n/index.js'
import type { GlanceFigure } from '../src/data/useGlance.js'
import type { Translate } from '../src/format.js'

// A stub, not a real i18n instance: it names both the key and every interpolation value it was
// called with, so a test can assert on what these helpers asked for without also asserting what a
// translator wrote back. Copied from format.test.ts's own stubT.
function stubT(): { t: Translate, calls: [string, Record<string, unknown> | undefined][] } {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const t: Translate = (key, options) => {
    calls.push([key, options])
    return `t(${key})`
  }
  return { t, calls }
}

function realT(language: string): Translate {
  const i18n = initI18n(language)
  return (key, options) => i18n.t(key, options)
}

function figure(over: Partial<GlanceFigure> = {}): GlanceFigure {
  return {
    metric: 'steps', value: 8000, unit: 'count', baseline: null,
    asOfDate: '2026-09-23', asOfMs: null, partial: false, staleSources: [], strip: [], standing: null,
    ...over,
  }
}

describe('formatFigure', () => {
  it('answers null for a null value', () => {
    expect(formatFigure(figure({ value: null }), 'en')).toBeNull()
  })

  it('formats sleep_asleep_minutes as a duration', () => {
    expect(formatFigure(figure({ metric: 'sleep_asleep_minutes', value: 419 }), 'en')).toBe('6h 59m')
  })

  it('formats sleep_bedtime_minutes and sleep_waketime_minutes as a clock time', () => {
    expect(formatFigure(figure({ metric: 'sleep_bedtime_minutes', value: -40 }), 'en')).toBe('23:20')
    expect(formatFigure(figure({ metric: 'sleep_waketime_minutes', value: 390 }), 'en')).toBe('06:30')
  })

  it('formats active_minutes and recovery_index as the plain integer', () => {
    expect(formatFigure(figure({ metric: 'active_minutes', value: 42.6 }), 'en')).toBe('43')
    expect(formatFigure(figure({ metric: 'recovery_index', value: 71 }), 'en')).toBe('71')
  })

  it('formats everything else through the catalogue precision', () => {
    expect(formatFigure(figure({ metric: 'steps', value: 8700 }), 'en')).toBe('8,700')
    expect(formatFigure(figure({ metric: 'steps', value: 8700 }), 'nl')).toBe('8.700')
  })
})

describe('usualLine', () => {
  const baseline = { center: 8700, low: 8000, high: 9000, thin: false }

  it('answers null with no value or no baseline', () => {
    const { t } = stubT()
    expect(usualLine(figure({ value: null, baseline }), t, 'en')).toBeNull()
    expect(usualLine(figure({ value: 8500, baseline: null }), t, 'en')).toBeNull()
  })

  it('reads within, above and below the usual band', () => {
    const { t, calls } = stubT()
    expect(usualLine(figure({ value: 8500, baseline, standing: 'within' }), t, 'en')).toBe('t(glance.usual.within)')
    expect(usualLine(figure({ value: 9500, baseline, standing: 'above' }), t, 'en')).toBe('t(glance.usual.above)')
    expect(usualLine(figure({ value: 7000, baseline, standing: 'below' }), t, 'en')).toBe('t(glance.usual.below)')
    expect(calls).toEqual([
      ['glance.usual.within', { low: '8,000', high: '9,000' }],
      ['glance.usual.above', { low: '8,000', high: '9,000' }],
      ['glance.usual.below', { low: '8,000', high: '9,000' }],
    ])
  })

  // The verdict is the server's, not a re-comparison here: a value inside the band still reads
  // above when standing says so, which would never happen from core's own honest computation but
  // proves the web trusts the field rather than recomputing it from rounded numbers.
  it('trusts the server\'s standing even when the value itself sits inside the band', () => {
    const { t } = stubT()
    expect(usualLine(figure({ value: 8500, baseline, standing: 'above' }), t, 'en')).toBe('t(glance.usual.above)')
  })

  it('reads thin as not enough history, regardless of value', () => {
    const { t } = stubT()
    expect(usualLine(figure({ value: 8500, baseline: { ...baseline, thin: true } }), t, 'en')).toBe('t(glance.usual.thin)')
  })

  // Never "below" while partial: a figure still accumulating today is not a shortfall against a
  // full day's usual, even when it currently sits under the low end of the band.
  it('reads a partial figure as "so far", never as below, even under its low', () => {
    const { t, calls } = stubT()
    expect(usualLine(figure({ value: 3000, baseline, partial: true }), t, 'en')).toBe('t(glance.usual.partial)')
    expect(calls).toEqual([['glance.usual.partial', { center: '8,700' }]])
  })

  it('formats the partial center the same way as the value, for a duration metric', () => {
    const { t, calls } = stubT()
    usualLine(
      figure({ metric: 'sleep_asleep_minutes', value: 200, baseline: { center: 430, low: 400, high: 460, thin: false }, partial: true }),
      t, 'en',
    )
    expect(calls).toEqual([['glance.usual.partial', { center: '7h 10m' }]])
  })
})

describe('asOfLine', () => {
  const opts = { today: '2026-09-23', timezone: 'Europe/Amsterdam' }

  it('answers null with no value', () => {
    const { t } = stubT()
    expect(asOfLine(figure({ value: null }), opts, t, 'en')).toBeNull()
  })

  it('reads "as of" a time when asOfMs is known and today', () => {
    const { t, calls } = stubT()
    // 2026-09-23T09:32:00Z is 11:32 in Europe/Amsterdam (CEST, UTC+2).
    const ms = Date.parse('2026-09-23T09:32:00Z')
    expect(asOfLine(figure({ value: 8000, asOfDate: '2026-09-23', asOfMs: ms }), opts, t, 'en')).toBe('t(glance.asOf.time)')
    expect(calls).toEqual([['glance.asOf.time', { time: '11:32' }]])
  })

  it('reads today when asOfDate matches today but no instant is known', () => {
    const { t } = stubT()
    expect(asOfLine(figure({ value: 8000, asOfDate: '2026-09-23', asOfMs: null }), opts, t, 'en')).toBe('t(glance.asOf.today)')
  })

  it('reads yesterday when asOfDate is the day before today', () => {
    const { t } = stubT()
    expect(asOfLine(figure({ value: 8000, asOfDate: '2026-09-22', asOfMs: null }), opts, t, 'en')).toBe('t(glance.asOf.yesterday)')
  })

  it('reads a sleep figure as the night of its date, regardless of asOfMs', () => {
    const { t, calls } = stubT()
    const ms = Date.parse('2026-09-23T09:32:00Z')
    expect(asOfLine(figure({ value: 419, asOfDate: '2026-09-22', asOfMs: ms }), { ...opts, night: true }, t, 'en'))
      .toBe('t(glance.asOf.night)')
    expect(calls).toEqual([['glance.asOf.night', { date: 'Sep 22' }]])
  })
})

describe('glanceText with real translations', () => {
  const baseline = { center: 8700, low: 8000, high: 9000, thin: false }
  const opts = { today: '2026-09-23', timezone: 'Europe/Amsterdam' }

  it.each([
    ['en', 'within your usual 8,000 – 9,000', 'above your usual 8,000 – 9,000', 'below your usual 8,000 – 9,000',
      'not enough history for a usual yet', 'so far; your usual day 8,700'],
    ['nl', 'binnen je gebruikelijke bereik 8.000 – 9.000', 'boven je gebruikelijke bereik 8.000 – 9.000',
      'onder je gebruikelijke bereik 8.000 – 9.000',
      'nog te weinig geschiedenis voor een gebruikelijke waarde', 'tot nu toe; op een gewone dag 8.700'],
  ] as const)('reads within / above / below / thin / partial in %s', (language, within, above, below, thin, partial) => {
    const t = realT(language)
    expect(usualLine(figure({ value: 8500, baseline, standing: 'within' }), t, language)).toBe(within)
    expect(usualLine(figure({ value: 9500, baseline, standing: 'above' }), t, language)).toBe(above)
    expect(usualLine(figure({ value: 7000, baseline, standing: 'below' }), t, language)).toBe(below)
    expect(usualLine(figure({ value: 8500, baseline: { ...baseline, thin: true } }), t, language)).toBe(thin)
    expect(usualLine(figure({ value: 3000, baseline, partial: true }), t, language)).toBe(partial)
  })

  it.each([
    ['en', 'as of 11:32', 'today', 'yesterday', 'night of Sep 22'],
    ['nl', 'bijgewerkt om 11:32', 'vandaag', 'gisteren', 'nacht van 22 sep'],
  ] as const)('reads the as-of clauses in %s', (language, asOfTime, today, yesterday, night) => {
    const t = realT(language)
    const ms = Date.parse('2026-09-23T09:32:00Z')
    expect(asOfLine(figure({ value: 8000, asOfDate: '2026-09-23', asOfMs: ms }), opts, t, language)).toBe(asOfTime)
    expect(asOfLine(figure({ value: 8000, asOfDate: '2026-09-23', asOfMs: null }), opts, t, language)).toBe(today)
    expect(asOfLine(figure({ value: 8000, asOfDate: '2026-09-22', asOfMs: null }), opts, t, language)).toBe(yesterday)
    expect(asOfLine(figure({ value: 419, asOfDate: '2026-09-22', asOfMs: ms }), { ...opts, night: true }, t, language)).toBe(night)
  })
})

describe('paceKey', () => {
  it('words the pace from the server\'s verdict, and says nothing on a thin one', () => {
    const pace = { center: 5900, low: 5000, high: 6800, thin: false, value: 5900, atMs: 0, standing: 'ahead' as const }
    expect(paceKey(pace)).toBe('glance.pace.ahead')
    expect(paceKey({ ...pace, standing: 'behind' })).toBe('glance.pace.behind')
    expect(paceKey({ ...pace, thin: true, standing: null })).toBeNull()
    expect(paceKey(null)).toBeNull()
  })
})

describe('greetingKey', () => {
  it('greets by the hour in the person\'s own zone', () => {
    expect(greetingKey(Date.UTC(2026, 8, 24, 4, 0), 'Europe/Amsterdam')).toBe('glance.greeting.morning') // 06:00 local
    expect(greetingKey(Date.UTC(2026, 8, 24, 10, 0), 'Europe/Amsterdam')).toBe('glance.greeting.afternoon') // 12:00 local
    expect(greetingKey(Date.UTC(2026, 8, 24, 16, 0), 'Europe/Amsterdam')).toBe('glance.greeting.evening') // 18:00 local
    expect(greetingKey(Date.UTC(2026, 8, 24, 1, 0), 'Europe/Amsterdam')).toBe('glance.greeting.evening') // 03:00 local
  })
})
