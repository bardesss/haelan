import { describe, it, expect } from 'vitest'
import { formatFigureDifference, formatFigureRange, formatFigureValue, verdictLine, stripOf } from '../src/pages/detail/figureText.js'
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

  // Dutch writes the hour "u" (for "uur"); a short span keeps its "min" in both languages.
  it('writes a duration\'s hour as "u" in Dutch, and leaves a short span\'s "min" alone', () => {
    expect(formatFigureValue(figure({ unit: 'minutes', precision: 0 }), 396, 'nl', tNl)).toBe('6u\u00a036m')
    expect(formatFigureValue(figure({ unit: 'minutes', metric: 'sleep_latency_minutes', precision: 0 }), 12, 'nl', tNl)).toBe('12\u00a0min')
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

describe('formatFigureValue: workout units', () => {
  it('formats seconds_per_km as a pace with the /km suffix', () => {
    expect(formatFigureValue(figure({ unit: 'seconds_per_km', precision: 0 }), 324, 'en', t)).toBe('5:24\u00a0/km')
    expect(formatFigureValue(figure({ unit: 'seconds_per_km', precision: 0 }), 324, 'nl', tNl)).toBe('5:24\u00a0/km')
  })

  it('formats meters_per_second as km/h at one decimal, km/u in Dutch', () => {
    expect(formatFigureValue(figure({ unit: 'meters_per_second', precision: 2 }), 3.4166666, 'en', t)).toBe('12.3\u00a0km/h')
    expect(formatFigureValue(figure({ unit: 'meters_per_second', precision: 2 }), 3.4166666, 'nl', tNl)).toBe('12,3\u00a0km/u')
  })

  it('formats seconds_per_100m as a stopwatch per 100 m, the unit once after a range', () => {
    const swim = figure({ unit: 'seconds_per_100m', precision: 0 })
    expect(formatFigureValue(swim, 125, 'en', t)).toBe('2:05\u00a0/100\u202fm')
    expect(formatFigureValue(swim, 125, 'nl', tNl)).toBe('2:05\u00a0/100\u202fm')
    expect(formatFigureRange(swim, 115, 125, 'en', t)).toEqual({ low: '1:55', high: '2:05\u00a0/100\u202fm' })
    // A higher number is the slower swim, so it is worded as a pace is.
    const baseline = { center: 120, low: 115, high: 125, thin: false }
    expect(verdictLine({ ...swim, value: 130, baseline, standing: 'above' }, 'en', t)).toBe('slower than your usual 1:55 \u2013 2:05\u00a0/100\u202fm')
    expect(verdictLine({ ...swim, value: 110, baseline, standing: 'below' }, 'nl', tNl)).toBe('sneller dan je gebruikelijke 1:55 \u2013 2:05\u00a0/100\u202fm')
  })

  it('takes a swim pace difference in whole seconds per 100 m', () => {
    const swim = figure({ unit: 'seconds_per_100m', precision: 0 })
    expect(formatFigureDifference(swim, 121.4, 125.2, 'en', t)).toBe('-4\u00a0s/100 m')
    expect(formatFigureDifference(swim, 121.4, 125.2, 'nl', tNl)).toBe('-4\u00a0s/100 m')
  })

  it('formats meters under 1000 as whole meters', () => {
    expect(formatFigureValue(figure({ unit: 'meters', precision: 0 }), 420, 'en', t)).toBe('420\u00a0m')
    expect(formatFigureValue(figure({ unit: 'meters', precision: 0 }), 420, 'nl', tNl)).toBe('420\u00a0m')
  })

  it('formats meters at or above 1000 as kilometers at two decimals', () => {
    expect(formatFigureValue(figure({ unit: 'meters', precision: 0 }), 5200, 'en', t)).toBe('5.20\u00a0km')
    expect(formatFigureValue(figure({ unit: 'meters', precision: 0 }), 5200, 'nl', tNl)).toBe('5,20\u00a0km')
  })

  it("keeps the workout page's climb and a swim's distance in whole metres past 1000, and their difference with them", () => {
    const climb = figure({ unit: 'meters', precision: 0, metric: 'elevationGain', value: 1250 })
    const swim = figure({ unit: 'meters', precision: 0, metric: 'swimDistance', value: 1500 })
    const run = figure({ unit: 'meters', precision: 0, metric: 'distance', value: 1500 })
    expect(formatFigureValue(climb, 1250, 'en', t)).toBe('1,250 m')
    expect(formatFigureValue(swim, 1500, 'nl', tNl)).toBe('1.500 m')
    expect(formatFigureDifference(climb, 1250, 1100, 'en', t)).toBe('+150')
    expect(formatFigureDifference(swim, 1500, 1750, 'nl', tNl)).toBe('-250')
    // The same metres as a run's distance still turn to kilometres, value and difference alike.
    expect(formatFigureValue(run, 1500, 'en', t)).toBe('1.50 km')
    expect(formatFigureDifference(run, 1500, 1750, 'en', t)).toBe('-0.25')
  })

  it('formats seconds under an hour as an elapsed mm:ss', () => {
    expect(formatFigureValue(figure({ unit: 'seconds', precision: 0 }), 1684, 'en', t)).toBe('28:04')
    expect(formatFigureValue(figure({ unit: 'seconds', precision: 0 }), 1684, 'nl', tNl)).toBe('28:04')
  })

  it('formats seconds at or above an hour as an elapsed h:mm:ss', () => {
    expect(formatFigureValue(figure({ unit: 'seconds', precision: 0 }), 3904, 'en', t)).toBe('1:05:04')
    expect(formatFigureValue(figure({ unit: 'seconds', precision: 0 }), 3904, 'nl', tNl)).toBe('1:05:04')
  })

  it('formats trimp as a plain number', () => {
    expect(formatFigureValue(figure({ unit: 'trimp', precision: 0 }), 86, 'en', t)).toBe('86')
    expect(formatFigureValue(figure({ unit: 'trimp', precision: 0 }), 86, 'nl', tNl)).toBe('86')
  })

  it('formats kcal with the kcal suffix', () => {
    expect(formatFigureValue(figure({ unit: 'kcal', precision: 0 }), 412, 'en', t)).toBe('412\u00a0kcal')
    expect(formatFigureValue(figure({ unit: 'kcal', precision: 0 }), 412, 'nl', tNl)).toBe('412\u00a0kcal')
  })

  it('formats steps_per_minute with the /min suffix', () => {
    expect(formatFigureValue(figure({ unit: 'steps_per_minute', precision: 0 }), 172, 'en', t)).toBe('172\u00a0/min')
    expect(formatFigureValue(figure({ unit: 'steps_per_minute', precision: 0 }), 172, 'nl', tNl)).toBe('172\u00a0/min')
  })

  it('formats ratio as a percent at the figure precision', () => {
    expect(formatFigureValue(figure({ unit: 'ratio', precision: 1 }), 8.2, 'en', t)).toBe('8.2\u00a0%')
    expect(formatFigureValue(figure({ unit: 'ratio', precision: 1 }), 8.2, 'nl', tNl)).toBe('8,2\u00a0%')
  })

  it('formats ml_per_kg_min as a plain number', () => {
    expect(formatFigureValue(figure({ unit: 'ml_per_kg_min', precision: 0 }), 52, 'en', t)).toBe('52')
    expect(formatFigureValue(figure({ unit: 'ml_per_kg_min', precision: 0 }), 52, 'nl', tNl)).toBe('52')
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
      .toBe('binnen je gebruikelijke bereik 6u\u00a020m – 7u\u00a000m')
  })
})

describe('short spans', () => {
  // A few minutes read as minutes, not as a duration with an empty hour in front of it.
  for (const metric of ['active_minutes', 'active_zone_minutes', 'sleep_latency_minutes', 'sleep_after_wake_minutes', 'sleep_bedtime_variability']) {
    it(`formats ${metric} as plain minutes`, () => {
      expect(formatFigureValue(figure({ metric, unit: 'minutes' }), 12, 'en', t)).toBe('12\u00a0min')
      expect(formatFigureValue(figure({ metric, unit: 'minutes' }), 69, 'nl', tNl)).toBe('69\u00a0min')
    })
  }

  it('keeps a long span a duration', () => {
    expect(formatFigureValue(figure({ metric: 'sleep_awake_minutes', unit: 'minutes' }), 25, 'en', t)).toBe('0h\u00a025m')
  })
})

describe('a stored millimetre distance', () => {
  // The period reads' distance and climb (METRICS stores both in millimetres).
  it('reads a distance in kilometres, one decimal below a hundred and whole above', () => {
    const distance = figure({ metric: 'distance', unit: 'millimeters' })
    expect(formatFigureValue(distance, 6_140_000, 'en', t)).toBe('6.1 km')
    expect(formatFigureValue(distance, 41_800_000, 'nl', tNl)).toBe('41,8 km')
    expect(formatFigureValue(distance, 183_400_000, 'en', t)).toBe('183 km')
    expect(formatFigureValue(distance, 2_084_000_000, 'nl', tNl)).toBe('2.084 km')
  })

  it('reads a climb in whole metres', () => {
    expect(formatFigureValue(figure({ metric: 'altitude_gain', unit: 'millimeters' }), 420_400, 'en', t)).toBe('420 m')
  })

  it('reads any other millimetre figure as its plain number, never as a distance', () => {
    expect(formatFigureValue(figure({ metric: 'height', unit: 'millimeters' }), 1_780_000, 'en', t)).toBe('1,780,000')
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
    expect(formatFigureValue(figure({ unit: 'minutes' }), 92, 'en', t)).toBe('1h\u00a032m')
    expect(formatFigureValue(figure({ unit: 'bpm' }), 58, 'en', t)).toBe('58\u00a0bpm')
    expect(formatFigureValue(figure({ unit: 'breaths_per_minute', precision: 1 }), 14.5, 'en', t)).toBe('14.5\u00a0breaths/min')
  })
})

// A range names its unit once, after the second number: "60 – 65 bpm", not "60 bpm – 65 bpm". A
// unit that is part of each number's own shape (a duration's h and m, a clock) stays on both.
describe('a range prints its unit once', () => {
  it('drops the unit from the low end when both ends share it', () => {
    const baseline = { center: 62, low: 60, high: 65, thin: false }
    expect(verdictLine(figure({ unit: 'bpm', value: 70, baseline, standing: 'above' }), 'en', t))
      .toBe('above your usual 60 – 65\u00a0bpm')
    expect(verdictLine(figure({ unit: 'percent', value: 90, baseline: { center: 93, low: 91, high: 95, thin: false }, standing: 'below' }), 'nl', tNl))
      .toBe('onder je gebruikelijke bereik 91 – 95\u00a0%')
  })

  it('keeps both ends of a duration whole', () => {
    const baseline = { center: 400, low: 380, high: 420, thin: false }
    expect(verdictLine(figure({ unit: 'minutes', value: 400, baseline, standing: 'within' }), 'en', t))
      .toBe('within your usual 6h\u00a020m – 7h\u00a000m')
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
