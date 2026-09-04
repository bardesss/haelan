import { describe, expect, it } from 'vitest'
import { numberOrNull, workoutSummary } from '../src/data/workoutSummary.js'

describe('numberOrNull', () => {
  // The whole reason this function exists. Number(null) is 0 and Number('') is 0, so a reader that
  // coerces before checking presence prints a real zero for a session that recorded nothing.
  it('answers null for every shape of absence, rather than zero', () => {
    expect(numberOrNull(null)).toBeNull()
    expect(numberOrNull(undefined)).toBeNull()
    expect(numberOrNull('')).toBeNull()
    expect(numberOrNull('   ')).toBeNull()
  })

  // The other half, and the one a careless guard breaks: a recorded zero is a measurement and must
  // survive. A reader written as `value ? Number(value) : null` fails this and passes the test
  // above, which is why both directions are asserted.
  it('keeps a real zero, from either JSON type', () => {
    expect(numberOrNull(0)).toBe(0)
    expect(numberOrNull('0')).toBe(0)
  })

  // Signed zero survives arithmetic and survives JSON, and it does not survive formatting
  // unchanged: (-0).toLocaleString('nl', { maximumFractionDigits: 0 }) is "-0", so a row would
  // print a minus sign in front of a zero distance. The same signed zero was fixed once already in
  // M3e-2's weight deltas; nothing in the live data carries one, and the clause costs one
  // comparison, so it is closed here rather than deferred on the false hope that the formatters
  // normalise it.
  it('normalises negative zero, which the formatters print with a minus sign', () => {
    expect(Object.is(numberOrNull(-0), 0), 'a number -0').toBe(true)
    expect(Object.is(numberOrNull('-0'), 0), 'the string "-0"').toBe(true)
    expect(Object.is(numberOrNull('-0.0'), 0), 'a string that parses to -0').toBe(true)
  })

  it('reads the two types the provider actually mixes', () => {
    expect(numberOrNull(169)).toBe(169)
    expect(numberOrNull('116')).toBe(116)
    expect(numberOrNull(0.3785216473620234)).toBeCloseTo(0.3785216473620234)
  })

  it('answers null for anything that is not a finite number', () => {
    expect(numberOrNull('abc')).toBeNull()
    expect(numberOrNull(Number.NaN)).toBeNull()
    expect(numberOrNull(Number.POSITIVE_INFINITY)).toBeNull()
    expect(numberOrNull({})).toBeNull()
    expect(numberOrNull([])).toBeNull()
  })
})

describe('workoutSummary', () => {
  // A real 54 minute run, with the field types the provider actually sends: calories a number,
  // heart rate and steps strings, distance in millimeters, pace in seconds per meter.
  it('reads a fully populated run and converts every unit once', () => {
    const summary = workoutSummary({
      exerciseType: 'RUNNING',
      metricsSummary: {
        caloriesKcal: 874,
        distanceMillimeters: 8488286,
        steps: '8821',
        averagePaceSecondsPerMeter: 0.3785216473620234,
        averageHeartRateBeatsPerMinute: '164',
        elevationGainMillimeters: 169906,
        activeZoneMinutes: '105',
      },
    })
    expect(summary.exerciseType).toBe('RUNNING')
    expect(summary.caloriesKcal).toBe(874)
    expect(summary.averageHeartRateBpm).toBe(164)
    expect(summary.steps).toBe(8821)
    expect(summary.distanceMeters).toBeCloseTo(8488.286)
    expect(summary.elevationGainMeters).toBeCloseTo(169.906)
    // seconds per meter to seconds per kilometer
    expect(summary.paceSecondsPerKm).toBeCloseTo(378.5216473620234)
  })

  // Ninety five of 192 sessions have no distance and 115 have no pace. Those fields must come back
  // null so the view can leave them out, rather than 0 so it prints "0,0 km" for a weights session.
  it('leaves an absent field null rather than zero', () => {
    const summary = workoutSummary({
      exerciseType: 'WEIGHTLIFTING',
      metricsSummary: { caloriesKcal: 169, averageHeartRateBeatsPerMinute: '116' },
    })
    expect(summary.caloriesKcal).toBe(169)
    expect(summary.distanceMeters).toBeNull()
    expect(summary.steps).toBeNull()
    expect(summary.paceSecondsPerKm).toBeNull()
    expect(summary.elevationGainMeters).toBeNull()
  })

  // attrs is one shape across both session kinds: on an exercise row the sleep fields are present
  // and null, so a key existing does not mean it carries a value.
  it('is not confused by the sleep fields an exercise row carries as null', () => {
    const summary = workoutSummary({
      type: null, mainSleep: null, stagesStatus: null, summary: null, shortAwakenings: null,
      exerciseType: 'WALKING', metricsSummary: { caloriesKcal: 90 },
    })
    expect(summary.exerciseType).toBe('WALKING')
    expect(summary.caloriesKcal).toBe(90)
  })

  // The route answers attrs as whatever was stored. A reader that assumes an object shape throws on
  // the whole page rather than dropping one row, and this app has no error boundary.
  it('answers an all null summary for junk rather than throwing', () => {
    for (const junk of [null, undefined, 'not an object', 42, []]) {
      expect(() => workoutSummary(junk)).not.toThrow()
      expect(workoutSummary(junk).exerciseType).toBeNull()
    }
  })
})
