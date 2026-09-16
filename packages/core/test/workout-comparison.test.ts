import { describe, expect, it } from 'vitest'
import {
  compareWorkout, COMPARISON_LIMIT, COMPARISON_MIN, COMPARISON_WINDOW_DAYS,
} from '../src/api/workoutComparison.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 3, 6, 0)

const run = (id: string, daysAgo: number, over: Record<string, unknown> = {}) => ({
  id, startMs: NOW - daysAgo * DAY, excluded: false,
  attrs: {
    exerciseType: 'RUNNING',
    metricsSummary: {
      averagePaceSecondsPerMeter: 0.3, averageHeartRateBeatsPerMinute: '150',
      distanceMillimeters: 5_000_000, ...over,
    },
  },
})

// The subject: 0.28 s/m is faster than the 0.3 the helper above gives every candidate.
const subject = run('subject', 0, { averagePaceSecondsPerMeter: 0.28 })

describe('comparing a workout against recent ones of the same type', () => {
  it('counts how many it beat rather than ranking it', () => {
    // "faster than 8 of your last 12 runs", not "8th of 12": a rank implies a completeness only
    // M6's archive-wide records can honestly claim.
    const result = compareWorkout(subject, [run('a', 1), run('b', 2), run('c', 3)])
    expect(result.reason).toBeNull()
    expect(result.pace).toEqual({ better: 3, of: 3 })
  })

  it('withholds itself with a reason when there are fewer than three prior workouts', () => {
    const result = compareWorkout(subject, [run('a', 1), run('b', 2)])
    expect(result.reason).toBe('too-few')
    expect(result.of).toBe(2)
    expect(COMPARISON_MIN).toBe(3)
  })

  it('withholds itself when the subject has no exercise type to compare within', () => {
    const untyped = { id: 's', startMs: NOW, excluded: false, attrs: { metricsSummary: {} } }
    expect(compareWorkout(untyped, [run('a', 1), run('b', 2), run('c', 3)]).reason).toBe('no-type')
  })

  it('counts a tie as not better, in either direction', () => {
    const tied = run('subject', 0)
    const result = compareWorkout(tied, [run('a', 1), run('b', 2), run('c', 3)])
    expect(result.pace).toEqual({ better: 0, of: 3 })
  })

  it('ignores a workout of a different type', () => {
    const walk = { ...run('walk', 1), attrs: { exerciseType: 'WALKING', metricsSummary: {} } }
    expect(compareWorkout(subject, [run('a', 1), run('b', 2), run('c', 3), walk]).of).toBe(3)
  })

  it('ignores a workout the person excluded', () => {
    // Somebody who excluded a session has already said it should not count.
    const dropped = { ...run('d', 4), excluded: true }
    expect(compareWorkout(subject, [run('a', 1), run('b', 2), run('c', 3), dropped]).of).toBe(3)
  })

  it('ignores anything outside the trailing window, and anything after the subject', () => {
    const old = run('old', COMPARISON_WINDOW_DAYS + 1)
    const later = run('later', -1)
    expect(compareWorkout(subject, [run('a', 1), run('b', 2), run('c', 3), old, later]).of).toBe(3)
    expect(COMPARISON_WINDOW_DAYS).toBe(90)
  })

  it('includes a candidate exactly on the window\'s own edge', () => {
    // Pins the `>=` in the window filter rather than merely reading it as correct: a boundary
    // session dropped by an off-by-one (`>` instead of `>=`) would pass the test above too, since
    // that test only ever exercises one day inside the window and one day past it - never the
    // edge itself.
    const boundary = run('boundary', COMPARISON_WINDOW_DAYS)
    const result = compareWorkout(subject, [run('a', 1), run('b', 2), run('c', 3), boundary])
    expect(result.of).toBe(4)
  })

  it('takes at most the twenty most recent inside the window', () => {
    const many = Array.from({ length: 30 }, (_, index) => run(`s${index}`, index + 1))
    expect(compareWorkout(subject, many).of).toBe(COMPARISON_LIMIT)
  })

  it('drops a facet that too few prior workouts recorded, and keeps the ones they did', () => {
    const withoutHr = (id: string, daysAgo: number) => ({
      ...run(id, daysAgo), attrs: {
        exerciseType: 'RUNNING',
        metricsSummary: { averagePaceSecondsPerMeter: 0.3, distanceMillimeters: 5_000_000 },
      },
    })
    const result = compareWorkout(subject, [withoutHr('a', 1), withoutHr('b', 2), withoutHr('c', 3)])
    expect(result.heartRate).toBeNull()
    expect(result.pace).toEqual({ better: 3, of: 3 })
  })

  it('answers no facets at all when nothing was compared', () => {
    const result = compareWorkout(subject, [])
    expect(result).toEqual({
      exerciseType: 'RUNNING', of: 0, reason: 'too-few',
      pace: null, heartRate: null, distance: null, cardioLoad: null,
    })
  })
})

/**
 * Cardio load, compared the way the other three measures are.
 *
 * The workout page prints a load of 86 TRIMP and nothing anywhere says whether that is a lot. It
 * cannot be answered in the abstract - a training impulse has no good or bad value, only a value
 * relative to what this person usually does - and this card already exists to answer exactly that
 * shape of question, as a count rather than a rank.
 *
 * Deliberately NOT a band or a verdict. TrainingLoadCard refuses to read this family of figure as
 * injury risk, and says why: a personal archive is not licensed to say that. A colour here would
 * cross the same line more quietly.
 *
 * Higher is "more", not "better", and the facet comparator is fine with that: it counts how many
 * were lower, and the copy above it says harder rather than better.
 */
describe('comparing a workout on cardio load', () => {
  const zones = (light: number, moderate: number, vigorous: number, peak: number) => ({
    heartRateZoneDurations: {
      lightTime: `${light}s`, moderateTime: `${moderate}s`,
      vigorousTime: `${vigorous}s`, peakTime: `${peak}s`,
    },
  })

  // 600s in each zone is 10 minutes each: 10*1 + 10*2 + 10*3 + 10*4 = 100.
  const loaded = (id: string, daysAgo: number, seconds: number) =>
    run(id, daysAgo, zones(seconds, seconds, seconds, seconds))

  it('counts how many recent workouts carried less load than this one', () => {
    const heavy = run('subject', 0, zones(1200, 1200, 1200, 1200))
    const result = compareWorkout(heavy, [loaded('a', 1, 600), loaded('b', 2, 600), loaded('c', 3, 600)])
    expect(result.cardioLoad).toEqual({ better: 3, of: 3 })
  })

  it('counts none when this workout was the lightest of them', () => {
    const light = run('subject', 0, zones(60, 60, 60, 60))
    const result = compareWorkout(light, [loaded('a', 1, 600), loaded('b', 2, 600), loaded('c', 3, 600)])
    expect(result.cardioLoad).toEqual({ better: 0, of: 3 })
  })

  // The ordinary case on a real archive rather than a guard against a rarity: a device that
  // recorded no zone breakdown has no load, and a session compared against three of those has
  // nothing to say.
  it('drops the facet when the subject recorded no zones', () => {
    const result = compareWorkout(subject, [loaded('a', 1, 600), loaded('b', 2, 600), loaded('c', 3, 600)])
    expect(result.cardioLoad).toBeNull()
  })

  it('drops the facet when too few of the compared workouts recorded zones', () => {
    const heavy = run('subject', 0, zones(1200, 1200, 1200, 1200))
    const result = compareWorkout(heavy, [loaded('a', 1, 600), run('b', 2), run('c', 3)])
    expect(result.cardioLoad).toBeNull()
  })
})
