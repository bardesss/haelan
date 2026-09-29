import { describe, it, expect } from 'vitest'
import { formatFigureValue, verdictLine, stripOf } from '../src/pages/detail/figureText.js'
import type { PageFigure } from '../src/data/useNightPage.js'
import type { Translate } from '../src/format.js'
import { initI18n } from '../src/i18n/index.js'

// The real catalogues through a real i18next instance, not a stub: a stub asserts what the test
// author believed the Dutch said, and the page reads what nl.json actually says.
function tFor(language: 'en' | 'nl'): Translate {
  const instance = initI18n(language)
  return (key, options) => instance.t(key, options)
}

const t = tFor('en')
const tNl = tFor('nl')

function figure(overrides: Partial<PageFigure> & Pick<PageFigure, 'unit'>): PageFigure {
  return {
    metric: 'x', value: null, precision: 0, direction: 'neutral', baseline: null, standing: null,
    judged: null, strip: null, ...overrides,
  }
}

describe('formatFigureValue', () => {
  it('formats minutes as a duration', () => {
    expect(formatFigureValue(figure({ unit: 'minutes', precision: 0 }), 396, 'en', t)).toBe('6h\u00a036m')
  })

  it('formats minutes_from_local_midnight as a clock time, wrapping a negative value', () => {
    expect(formatFigureValue(figure({ unit: 'minutes_from_local_midnight', precision: 0 }), -40, 'en', t)).toBe('23:20')
  })

  it('formats percent with the unit suffix', () => {
    expect(formatFigureValue(figure({ unit: 'percent', precision: 0 }), 94, 'en', t)).toBe('94\u00a0%')
  })

  it('formats bpm with the unit suffix', () => {
    expect(formatFigureValue(figure({ unit: 'bpm', precision: 0 }), 58, 'en', t)).toBe('58\u00a0bpm')
  })

  it('formats milliseconds with the unit suffix', () => {
    expect(formatFigureValue(figure({ unit: 'milliseconds', precision: 0 }), 45, 'en', t)).toBe('45\u00a0ms')
  })

  it('formats breaths_per_minute with the recovery unit suffix', () => {
    expect(formatFigureValue(figure({ unit: 'breaths_per_minute', precision: 1 }), 14.5, 'en', t)).toBe('14.5\u00a0breaths/min')
  })

  it('formats celsius with the ° C unit suffix', () => {
    expect(formatFigureValue(figure({ unit: 'celsius', precision: 1 }), 0.6, 'en', t)).toBe('0.6\u00a0°C')
  })

  it('formats count as the number alone', () => {
    expect(formatFigureValue(figure({ unit: 'count', precision: 0 }), 2, 'en', t)).toBe('2')
  })

  it('formats an unrecognised unit as a plain number at the figure precision', () => {
    expect(formatFigureValue(figure({ unit: 'score', precision: 0 }), 75, 'en', t)).toBe('75')
  })

  it('formats null as the absent string', () => {
    expect(formatFigureValue(figure({ unit: 'minutes', precision: 0 }), null, 'en', t)).toBe('—')
  })
})

describe('verdictLine', () => {
  const baseline = { center: 400, low: 380, high: 420, thin: false }

  it('is null when the value is null', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: null, baseline }), 'en', t)).toBeNull()
  })

  it('is null when there is no baseline', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: 400, baseline: null }), 'en', t)).toBeNull()
  })

  it('says thin when the baseline is thin, regardless of standing', () => {
    const thin = { center: 400, low: 380, high: 420, thin: true }
    expect(verdictLine(figure({ unit: 'minutes', value: 400, baseline: thin, standing: 'within' }), 'en', t))
      .toBe('not enough history for a usual yet')
  })

  it('says within with the formatted low/high when standing is within', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: 400, baseline, standing: 'within' }), 'en', t))
      .toBe('within your usual 6h\u00a020m – 7h\u00a000m')
  })

  it('says above with the formatted low/high when standing is above', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: 430, baseline, standing: 'above' }), 'en', t))
      .toBe('above your usual 6h\u00a020m – 7h\u00a000m')
  })

  it('says below with the formatted low/high when standing is below', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: 370, baseline, standing: 'below' }), 'en', t))
      .toBe('below your usual 6h\u00a020m – 7h\u00a000m')
  })

  // A clock time off its usual is later or earlier, the dashboard night card's words for a bedtime
  // (glance.sleep.bedStanding), not "above" or "below" a range of clock readings.
  describe('on a clock time', () => {
    const bed = { center: -5, low: -30, high: 20, thin: false }
    it('says later or earlier than the usual, in both languages', () => {
      expect(verdictLine(figure({ unit: 'minutes_from_local_midnight', value: 50, baseline: bed, standing: 'above' }), 'en', t))
        .toBe('later than your usual 23:30 – 00:20')
      expect(verdictLine(figure({ unit: 'minutes_from_local_midnight', value: -60, baseline: bed, standing: 'below' }), 'en', t))
        .toBe('earlier than your usual 23:30 – 00:20')
      expect(verdictLine(figure({ unit: 'minutes_from_local_midnight', value: 50, baseline: bed, standing: 'above' }), 'nl', tNl))
        .toBe('later dan je gebruikelijke 23:30 – 00:20')
      expect(verdictLine(figure({ unit: 'minutes_from_local_midnight', value: -60, baseline: bed, standing: 'below' }), 'nl', tNl))
        .toBe('eerder dan je gebruikelijke 23:30 – 00:20')
    })
    it('still says within when it is inside the usual', () => {
      expect(verdictLine(figure({ unit: 'minutes_from_local_midnight', value: 8, baseline: bed, standing: 'within' }), 'en', t))
        .toBe('within your usual 23:30 – 00:20')
    })
    it('words a usual of one clock time as that time', () => {
      const one = { center: 420, low: 420, high: 420, thin: false }
      expect(verdictLine(figure({ unit: 'minutes_from_local_midnight', value: 450, baseline: one, standing: 'above' }), 'en', t))
        .toBe('later than your usual 07:00')
    })
  })

  it('says partial with the formatted center when standing is null but the baseline is not thin', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: 200, baseline, standing: null }), 'en', t))
      .toBe('so far; your usual day 6h\u00a040m')
  })

  it('says within in Dutch too', () => {
    expect(verdictLine(figure({ unit: 'minutes', value: 400, baseline, standing: 'within' }), 'nl', tNl))
      .toBe('binnen je gebruikelijke bereik 6h\u00a020m – 7h\u00a000m')
  })
})

describe('short spans', () => {
  // A few minutes read as minutes, not as a duration with an empty hour in front of it.
  for (const metric of ['active_minutes', 'sleep_latency_minutes', 'sleep_after_wake_minutes', 'sleep_bedtime_variability']) {
    it(`formats ${metric} as plain minutes`, () => {
      expect(formatFigureValue(figure({ metric, unit: 'minutes' }), 12, 'en', t)).toBe('12\u00a0min')
      expect(formatFigureValue(figure({ metric, unit: 'minutes' }), 69, 'nl', tNl)).toBe('69\u00a0min')
    })
  }

  it('keeps a long span a duration', () => {
    expect(formatFigureValue(figure({ metric: 'sleep_awake_minutes', unit: 'minutes' }), 25, 'en', t)).toBe('0h\u00a025m')
  })
})

describe('a usual that is a single value', () => {
  const zero = { center: 0, low: 0, high: 0, thin: false }

  it('reads as that value, in English and Dutch', () => {
    expect(verdictLine(figure({ unit: 'count', value: 0, baseline: zero, standing: 'within' }), 'en', t)).toBe('your usual 0')
    expect(verdictLine(figure({ unit: 'count', value: 0, baseline: zero, standing: 'within' }), 'nl', tNl)).toBe('je gebruikelijke 0')
  })

  it('keeps the direction when the value is off it', () => {
    expect(verdictLine(figure({ unit: 'count', value: 2, baseline: zero, standing: 'above' }), 'en', t)).toBe('above your usual 0')
  })
})

// A value never wraps inside itself ("1h⏎32m", "58⏎bpm"): every space inside one formatted value is
// a no-break space, so a narrow card breaks between words of the sentence, never inside a figure.
describe('a value kept on one line', () => {
  it('joins a duration\'s hours and minutes, and a number and its unit, with no-break spaces', () => {
    expect(formatFigureValue(figure({ unit: 'minutes' }), 92, 'en', t)).toBe('1h 32m')
    expect(formatFigureValue(figure({ unit: 'bpm' }), 58, 'en', t)).toBe('58 bpm')
    expect(formatFigureValue(figure({ unit: 'breaths_per_minute', precision: 1 }), 14.5, 'en', t)).toBe('14.5 breaths/min')
  })
})

// A range names its unit once, after the second number: "60 – 65 bpm", not "60 bpm – 65 bpm". A
// unit that is part of each number's own shape (a duration's h and m, a clock) stays on both.
describe('a range prints its unit once', () => {
  it('drops the unit from the low end when both ends share it', () => {
    const baseline = { center: 62, low: 60, high: 65, thin: false }
    expect(verdictLine(figure({ unit: 'bpm', value: 70, baseline, standing: 'above' }), 'en', t))
      .toBe('above your usual 60 – 65 bpm')
    expect(verdictLine(figure({ unit: 'percent', value: 90, baseline: { center: 93, low: 91, high: 95, thin: false }, standing: 'below' }), 'nl', tNl))
      .toBe('onder je gebruikelijke bereik 91 – 95 %')
  })

  it('keeps both ends of a duration whole', () => {
    const baseline = { center: 400, low: 380, high: 420, thin: false }
    expect(verdictLine(figure({ unit: 'minutes', value: 400, baseline, standing: 'within' }), 'en', t))
      .toBe('within your usual 6h 20m – 7h 00m')
  })
})

// A pace is seconds per kilometre, so a higher number is a slower run: its verdict says slower or
// faster, the way a clock time's says later or earlier, never above or below.
describe('on a pace', () => {
  const baseline = { center: 330, low: 320, high: 340, thin: false }
  it('says slower or faster than the usual, in both languages', () => {
    expect(verdictLine(figure({ unit: 'seconds_per_km', value: 360, baseline, standing: 'above' }), 'en', t))
      .toMatch(/^slower than your usual /)
    expect(verdictLine(figure({ unit: 'seconds_per_km', value: 300, baseline, standing: 'below' }), 'en', t))
      .toMatch(/^faster than your usual /)
    expect(verdictLine(figure({ unit: 'seconds_per_km', value: 300, baseline, standing: 'below' }), 'nl', tNl))
      .toMatch(/^sneller dan je gebruikelijke /)
    expect(verdictLine(figure({ unit: 'seconds_per_km', value: 360, baseline, standing: 'above' }), 'nl', tNl))
      .toMatch(/^langzamer dan je gebruikelijke /)
  })
  it('still says within when it is inside the usual', () => {
    expect(verdictLine(figure({ unit: 'seconds_per_km', value: 330, baseline, standing: 'within' }), 'en', t))
      .toMatch(/^within your usual /)
  })
})

describe('stripOf', () => {
  it('reads each day\'s judgement off the strip, for the dot\'s tone', () => {
    const strip = [
      { localDate: '2026-09-01', value: 400, band: null, standing: 'within', judged: null },
      { localDate: '2026-09-02', value: 430, band: null, standing: 'above', judged: 'better' },
    ] as PageFigure['strip']
    expect(stripOf(figure({ unit: 'minutes', strip }))?.pointJudged).toEqual([null, 'better'])
  })

  it('is null when the figure carries no strip', () => {
    expect(stripOf(figure({ unit: 'minutes', strip: null }))).toBeNull()
  })

  it('reads values, labels and standings off the strip, in order', () => {
    const strip = [
      { localDate: '2026-09-01', value: 400, band: null, standing: null },
      { localDate: '2026-09-02', value: null, band: null, standing: null },
      { localDate: '2026-09-03', value: 430, band: null, standing: 'above' },
    ] as PageFigure['strip']
    const result = stripOf(figure({ unit: 'minutes', strip }))
    expect(result?.values).toEqual([400, null, 430])
    expect(result?.labels).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(result?.pointStandings).toEqual([null, null, 'above'])
  })

  // One dot joins nothing: the strip is left off and the row falls back to its bar.
  it('is null with fewer than two readings to join', () => {
    const strip = [
      { localDate: '2026-09-01', value: null, band: null, standing: null },
      { localDate: '2026-09-02', value: 400, band: null, standing: null },
    ] as PageFigure['strip']
    expect(stripOf(figure({ unit: 'minutes', strip }))).toBeNull()
  })

  it('reports undefined bands for an all-thin strip - deleting this line drops the whole assertion, and the (unverified) untouched-baseline branch would then read as bands present', () => {
    const strip = [
      { localDate: '2026-09-01', value: 400, band: { center: 400, low: 380, high: 420, thin: true }, standing: null },
      { localDate: '2026-09-02', value: 410, band: { center: 400, low: 380, high: 420, thin: true }, standing: null },
    ] as PageFigure['strip']
    const result = stripOf(figure({ unit: 'minutes', strip }))
    expect(result?.bands).toBeUndefined()
  })
})
