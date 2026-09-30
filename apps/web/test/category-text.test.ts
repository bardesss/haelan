import { describe, it, expect } from 'vitest'
import { distanceText, sessionRateText } from '../src/pages/activity/categoryText.js'
import type { Translate } from '../src/format.js'
import { initI18n } from '../src/i18n/index.js'

// The real catalogues through a real i18next instance, as figure-text.test.ts reads them.
function tFor(language: 'en' | 'nl'): Translate {
  const instance = initI18n(language)
  return (key, options) => instance.t(key, options)
}
const t = tFor('en')
const tNl = tFor('nl')
const NB = ' '

describe('distanceText, the one distance the rows, the per-type totals and Records print', () => {
  it('reads km to one decimal below 100 and whole above, with a no-break space', () => {
    expect(distanceText('run', 8488, 'nl', tNl)).toBe(`8,5${NB}km`)
    expect(distanceText(null, 41_830, 'en', t)).toBe(`41.8${NB}km`)
    expect(distanceText('ride', 183_400, 'en', t)).toBe(`183${NB}km`)
  })

  it('reads under a kilometre in metres, and a swim in whole metres however far', () => {
    expect(distanceText('walk', 800, 'nl', tNl)).toBe(`800${NB}m`)
    expect(distanceText('swim', 4500, 'nl', tNl)).toBe(`4.500${NB}m`)
  })
})

describe('sessionRateText', () => {
  it("reads a ride's speed as sent and never turns its pace round, and a run's pace", () => {
    expect(sessionRateText('ride', { paceSecondsPerKm: 120, speedMetersPerSecond: null }, 'en', t)).toBeNull()
    expect(sessionRateText('ride', { paceSecondsPerKm: null, speedMetersPerSecond: 7.5 }, 'nl', tNl)).toBe(`27,0${NB}km/u`)
    expect(sessionRateText('run', { paceSecondsPerKm: 324, speedMetersPerSecond: null }, 'en', t)).toBe(`5:24${NB}/km`)
  })
})
