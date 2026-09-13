import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readWorkoutSplits } from '../src/query/workoutDerived.ts'
import { readSession } from '../src/query/sessions.ts'
import type { WorkoutSession } from '../src/query/sessions.ts'
import { sessions, sources } from '../src/db/schema/index.ts'

const OFFSET = 120
const MIN = 60_000
const START = Date.UTC(2026, 8, 13, 6, 0)

let t: TestDatabase
beforeEach(() => { t = createTestDatabase() })
afterEach(() => t.cleanup())

/** One person and the device that recorded their workout. Follows workout-cardio-load.test.ts's
 *  own helper of the same name. */
function seedPersonAndSource(): void {
  seedPerson(t.db, 'p1')
  t.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
}

function seedWorkout(endMs: number, attrs: unknown): WorkoutSession {
  t.db.insert(sessions).values({
    id: 'w1', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 'w1',
    startMs: START, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET,
    localDate: '2026-09-13', attrs: JSON.stringify(attrs), rawPayloadId: null,
  }).run()
  return readSession(t.db, { personId: 'p1', sessionId: 'w1' })!
}

/** One heart rate reading a minute for `count` minutes from the session start, value 100 + i, the
 *  same linear series workout-cardio-load.test.ts seeds, chosen so a split's hand-summed mean is
 *  cheap to check by hand. Three rows per minute (min, mean, max) because heart_rate is stored
 *  downsampled to the minute. */
function seedHeartRate(count: number): void {
  for (let i = 0; i < count; i += 1) {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(t.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: START + i * MIN, tzOffsetMinutes: OFFSET, agg, value: 100 + i,
      })
    }
  }
}

/** Alternates 100/300 minute to minute, for the budget-independence case below. A monotonic
 *  series (the plain `seedHeartRate` above) turned out not to discriminate: `thinBand` keeps each
 *  bucket's true low and high, which for a monotonic run are that bucket's own first and last
 *  point, so the interior point a bucket of three drops barely moves a linear mean. Verified by
 *  hand against the live reader before this was chosen - see the test's own comment. */
function seedHeartRateAlternating(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const value = i % 2 === 0 ? 100 : 300
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(t.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: START + i * MIN, tzOffsetMinutes: OFFSET, agg, value,
      })
    }
  }
}

/** A provider split/lap entry (workoutSummary.ts's raw shape), covering [startMinute, endMinute)
 *  of the session and carrying no averageHeartRateBeatsPerMinute, so the provider left it null. */
const rawSplit = (startMinute: number, endMinute: number, over: Record<string, unknown> = {}) => ({
  startTime: new Date(START + startMinute * MIN).toISOString(),
  endTime: new Date(START + endMinute * MIN).toISOString(),
  splitType: 'DISTANCE',
  activeDuration: `${(endMinute - startMinute) * 60}s`,
  metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: 0.3 },
  ...over,
})

describe('a workout\'s splits, filled', () => {
  it('fills every split the provider left null', () => {
    seedPersonAndSource()
    const session = seedWorkout(START + 80 * MIN, { splits: [rawSplit(0, 5), rawSplit(5, 10)] })
    seedHeartRate(80)

    const { autoSplits } = readWorkoutSplits(t.db, { personId: 'p1', session })
    expect(autoSplits).toHaveLength(2)
    expect(autoSplits.every((s) => s.averageHeartRateBpm !== null)).toBe(true)
    expect(autoSplits.every((s) => s.averageHeartRateBpmSource === 'trace')).toBe(true)
  })

  it('fills laps on the same terms', () => {
    seedPersonAndSource()
    const session = seedWorkout(START + 80 * MIN, { splitSummaries: [rawSplit(0, 5)] })
    seedHeartRate(80)

    const { laps } = readWorkoutSplits(t.db, { personId: 'p1', session })
    expect(laps[0]!.averageHeartRateBpmSource).toBe('trace')
  })

  // Controller ruling on this task: the brief's own version of this case called readWorkoutSplits
  // twice with identical arguments and compared the two results, which proves the function is
  // deterministic, not that it is budget independent - a reverted reader that thinned to a point
  // budget would answer the same (wrong) number twice just as readily as the right one once.
  //
  // 700 seeded minutes is the number that matters: readWindow's own DEFAULT_POINTS is 500
  // (query/intraday.ts), the budget a reverted `read` helper in sessionHeartRate.ts (one that
  // dropped `points: NO_THINNING`) would fall back to for a single-source window. A monotonic
  // series does not discriminate here - `thinBand`'s low/high bucketing keeps each bucket's own
  // first and last point for a monotonic run, so the interior points a bucket of three drops barely
  // move a linear mean. 100/300 alternating minute to minute does: dropped interior points are as
  // likely to be a 300 as a 100, and losing them unevenly moves the mean measurably. Minutes
  // 500-529 (half-open, 30 points, 15 of each value) hand-sum to 15*100 + 15*300 = 6000, mean 200
  // exactly. Verified against the live reader before this window was chosen: with
  // `points: NO_THINNING` temporarily removed from sessionHeartRate.ts's `read` helper, this same
  // fixture answered 195, not 200 - see task-12-report.md for both runs.
  it('gives a split heart rate that reflects every stored minute, not a thinned budget', () => {
    seedPersonAndSource()
    const SESSION_MINUTES = 700
    const session = seedWorkout(START + SESSION_MINUTES * MIN, { splits: [rawSplit(500, 530)] })
    seedHeartRateAlternating(SESSION_MINUTES)

    const { autoSplits } = readWorkoutSplits(t.db, { personId: 'p1', session })
    expect(autoSplits).toHaveLength(1)
    expect(autoSplits[0]!.averageHeartRateBpm).toBe(200)
    expect(autoSplits[0]!.averageHeartRateBpmSource).toBe('trace')
  })

  it('answers empty arrays for a session that recorded neither', () => {
    seedPersonAndSource()
    const session = seedWorkout(START + 80 * MIN, {})
    // No seedHeartRate() call either: the guard this reader states in its own comment - four
    // workouts in five record neither, so the trace is not read for them at all - means this case
    // would answer the same emptiness even with heart rate seeded, but leaving it out keeps the
    // point of the guard visible in the fixture itself.

    const result = readWorkoutSplits(t.db, { personId: 'p1', session })
    expect(result).toEqual({ autoSplits: [], laps: [] })
  })

  // CRITICAL 1's other half. readSession deliberately serves 'sleep' rows as well as 'exercise'
  // ones, and this reader has to refuse a sleep session for the same reason readWorkoutCardioLoad
  // does: a night has no exercise splits to fill. Attrs carry a split and heart rate is seeded
  // across the whole span, so an empty answer here is the kind guard firing before the trace is
  // ever read, not the "recorded neither" early return above answering for an unrelated reason.
  it('answers empty arrays for a sleep session, even one whose attrs carry a split', () => {
    seedPersonAndSource()
    t.db.insert(sessions).values({
      id: 'n1', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'n1',
      startMs: START, startOffsetMinutes: OFFSET, endMs: START + 480 * MIN, endOffsetMinutes: OFFSET,
      localDate: '2026-09-13', attrs: JSON.stringify({ splits: [rawSplit(0, 5)] }), rawPayloadId: null,
    }).run()
    const session = readSession(t.db, { personId: 'p1', sessionId: 'n1' })!
    seedHeartRate(480)

    const result = readWorkoutSplits(t.db, { personId: 'p1', session })
    expect(result).toEqual({ autoSplits: [], laps: [] })
  })
})
