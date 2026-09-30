import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema, shiftLocalDate, sessionTarget } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { explainTool } from '../src/mcp/tools/explain.ts'

interface WorkoutEvidence {
  excluded: boolean
  exerciseType: string | null
  earlierSessions: number | null
  hero: string | null
  figures: { key: string, standing: string | null }[] | null
  peakMinutes: number | null
  lastKilometre: { seconds: number, standing: string | null, earlierKilometres: number } | null
  secondHalfFasterBySecondsPerKm: number | null
  secondHalfFasterByMetersPerSecond: number | null
  standsOut: string | null
}

interface Answer { kind: string, finding: string, stoppedAt: string, walked: string[], evidence: WorkoutEvidence }

const SUBJECT_DATE = '2026-09-04'
const CLAIM_WORDS = /\b(because|caused?|causes|should|recommend\w*|ready|readiness|risk\w*|advice|diagnos\w*|next (run|session|time))\b/i

interface Values {
  /** Seconds per kilometre. */
  pace?: number
  /** Metres. */
  distance?: number
  /** Seconds in the vigorous zone. */
  vigorous?: number
  /** Seconds in the peak zone. */
  peak?: number
  /** Full-kilometre splits, each its seconds. */
  kilometres?: number[]
}

describe('explain, kind workout', () => {
  let test: TestDatabase
  let q: PersonQuery

  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'UTC' })
    test.db.insert(schema.sources).values({
      id: 'watch', personId: 'robin', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
    }).run()
    q = new PersonQuery(test.db, 'robin')
  })
  afterEach(() => test.cleanup())

  /**
   * One session with attrs in the shape mapSessions stores, as workout-page.test.ts seeds them: the
   * provider's own units inside metricsSummary, splits in its split shape.
   */
  function seedWorkout(id: string, localDate: string, exerciseType: string | null, v: Values, o: { excluded?: boolean, kind?: 'exercise' | 'sleep' } = {}): void {
    const startMs = Date.parse(`${localDate}T07:00:00Z`)
    const endMs = startMs + 40 * 60_000
    const metricsSummary = {
      ...(v.pace === undefined ? {} : { averagePaceSecondsPerMeter: v.pace / 1000 }),
      ...(v.distance === undefined ? {} : { distanceMillimeters: v.distance * 1000 }),
      ...(v.vigorous === undefined && v.peak === undefined ? {} : {
        heartRateZoneDurations: { lightTime: '300s', moderateTime: '300s', vigorousTime: `${v.vigorous ?? 0}s`, peakTime: `${v.peak ?? 0}s` },
      }),
    }
    let at = startMs
    const splits = v.kilometres?.map((seconds) => {
      const split = {
        startTime: new Date(at).toISOString(), endTime: new Date(at + seconds * 1000).toISOString(),
        splitType: 'DISTANCE', activeDuration: `${seconds}s`,
        metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: seconds / 1000 },
      }
      at += seconds * 1000
      return split
    })
    test.db.insert(schema.sessions).values({
      id, personId: 'robin', sourceId: 'watch', kind: o.kind ?? 'exercise', externalId: id,
      startMs, startOffsetMinutes: 0, endMs, endOffsetMinutes: 0, localDate, rawPayloadId: null,
      attrs: JSON.stringify({
        type: null, mainSleep: null, stagesStatus: null, summary: null, shortAwakenings: null,
        splitSummaries: null, exerciseEvents: null, displayName: null, notes: null, routeConsentRequired: null,
        exerciseMetadata: { hasGps: false }, exerciseType, metricsSummary, splits: splits ?? null, activeDuration: null,
      }),
    }).run()
    if (o.excluded === true) {
      test.db.insert(schema.overrides).values({
        id: `o-${id}`, personId: 'robin', scope: 'session', targetKey: sessionTarget(id), action: 'exclude', reason: 'test', createdAtMs: 0,
      }).run()
    }
  }

  /** `n` earlier runs every third day before SUBJECT_DATE, each value jittered either way on alternate runs. */
  function seedHistory(n: number, v: { pace: number, distance?: number, vigorous?: number }): void {
    for (let i = 0; i < n; i += 1) {
      const sign = i % 2 === 0 ? 1 : -1
      seedWorkout(`run-${i}`, shiftLocalDate(SUBJECT_DATE, -3 * (n - i)), 'RUNNING', {
        pace: v.pace + 5 * sign,
        ...(v.distance === undefined ? {} : { distance: v.distance + 100 * sign }),
        ...(v.vigorous === undefined ? {} : { vigorous: v.vigorous + 30 * sign }),
      })
    }
  }

  function explain(sessionId: string): Answer {
    const raw = explainTool.run(q, { kind: 'workout', sessionId }) as Omit<Answer, 'evidence'> & {
      evidence: { empty: unknown, recovery: unknown, workout: WorkoutEvidence }
    }
    expect(raw.kind).toBe('workout')
    expect(raw.evidence.empty).toBeNull()
    expect(raw.evidence.recovery).toBeNull()
    expect(raw.finding).not.toMatch(CLAIM_WORDS)
    expect(raw.walked.at(-1)).toBe(raw.stoppedAt)
    return { ...raw, evidence: raw.evidence.workout }
  }

  it('stops at excluded before reading anything about the session', () => {
    seedHistory(6, { pace: 330 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 280 }, { excluded: true })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('excluded')
    expect(answer.walked).toEqual(['excluded'])
    expect(answer.evidence.figures).toBeNull()
    expect(answer.finding).toContain('excluded by hand, so it is not judged')
  })

  it('stops at thinHistory with too few earlier sessions, even when the pace is far off', () => {
    seedHistory(3, { pace: 330 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 280 })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('thinHistory')
    expect(answer.walked).not.toContain('hero')
    expect(answer.evidence.earlierSessions).toBe(3)
    expect(answer.finding).toBe(
      'Only 3 earlier running sessions in the 90 days before 2026-09-04, too few for a usual pace to stand on, '
      + 'so nothing is judged against it. A thin history is low confidence, not evidence of nothing.',
    )
  })

  it('stops at thinHistory for a session with no type', () => {
    seedWorkout('subject', SUBJECT_DATE, null, { pace: 300 })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('thinHistory')
    expect(answer.finding).toContain('has no exercise type')
  })

  it('stops at hero when the figure the page leads with sits outside its usual', () => {
    // The hard minutes are far off too, so hardMinutes would answer; the lead figure comes first.
    seedHistory(6, { pace: 330, vigorous: 300 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 300, vigorous: 1800 })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('hero')
    expect(answer.walked).not.toContain('hardMinutes')
    expect(answer.evidence.hero).toBe('pace')
    expect(answer.evidence.standsOut).toBe('pace')
    expect(answer.finding).toMatch(/^This running session on 2026-09-04: pace 5:00\/km, faster than the usual 5:2\d\/km to 5:3\d\/km over its 6 earlier sessions of the type\.$/)
  })

  it('stops at hardMinutes when the pace is usual and the vigorous and peak minutes are not', () => {
    seedHistory(6, { pace: 330, vigorous: 300 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 330, vigorous: 1500, peak: 300 })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('hardMinutes')
    expect(answer.evidence.standsOut).toBe('hardZoneMinutes')
    expect(answer.evidence.peakMinutes).toBe(5)
    expect(answer.finding).toContain('minutes in the vigorous and peak zones 30 min, higher than the usual')
  })

  it('stops at lastKilometre before a later figure outside its usual', () => {
    // The distance is well past the usual, so otherFigure would answer; the last kilometre comes first.
    seedHistory(6, { pace: 330, distance: 5000 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 330, distance: 8000, kilometres: [330, 335, 325, 330, 290] })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('lastKilometre')
    expect(answer.walked).not.toContain('otherFigure')
    expect(answer.evidence.lastKilometre).toMatchObject({ seconds: 290, standing: 'below', earlierKilometres: 4 })
    expect(answer.finding).toMatch(/last full kilometre of the running session on 2026-09-04 took 4:50, faster than its 4 earlier kilometres, which usually took 5:2\d to 5:3\d\./)
  })

  it('does not judge the last kilometre against fewer than three earlier ones', () => {
    seedHistory(6, { pace: 330 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 330, kilometres: [330, 335, 290] })
    const answer = explain('subject')
    expect(answer.evidence.lastKilometre).toMatchObject({ standing: null, earlierKilometres: 2 })
    expect(answer.stoppedAt).toBe('withinUsual')
  })

  it('stops at otherFigure for a figure the page does not lead with', () => {
    seedHistory(6, { pace: 330, distance: 5000 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 330, distance: 8000 })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('otherFigure')
    expect(answer.evidence.standsOut).toBe('distance')
    expect(answer.finding).toContain('distance 8.00 km, longer than the usual')
  })

  it('ends at withinUsual when nothing sits outside its usual', () => {
    seedHistory(6, { pace: 330, distance: 5000 })
    seedWorkout('subject', SUBJECT_DATE, 'RUNNING', { pace: 331, distance: 5010 })
    const answer = explain('subject')
    expect(answer.stoppedAt).toBe('withinUsual')
    expect(answer.walked).toEqual(['excluded', 'thinHistory', 'hero', 'hardMinutes', 'lastKilometre', 'otherFigure', 'withinUsual'])
    expect(answer.evidence.standsOut).toBeNull()
  })

  it("carries a ride's split trend in m/s and a run's in s/km, each in its own field", () => {
    // A ride's page sends its split trend in speed; read as s/km it would claim a pace a ride has not.
    seedWorkout('ride', SUBJECT_DATE, 'BIKING', { pace: 120, distance: 4000, kilometres: [125, 125, 115, 115] })
    const ride = explain('ride').evidence
    expect(ride.secondHalfFasterBySecondsPerKm).toBeNull()
    expect(ride.secondHalfFasterByMetersPerSecond).toBeCloseTo(1000 / 115 - 1000 / 125, 6)
    seedWorkout('run', shiftLocalDate(SUBJECT_DATE, -1), 'RUNNING', { pace: 330, distance: 4000, kilometres: [340, 340, 320, 320] })
    const run = explain('run').evidence
    expect(run.secondHalfFasterBySecondsPerKm).toBeCloseTo(20, 6)
    expect(run.secondHalfFasterByMetersPerSecond).toBeNull()
  })

  it('refuses an id naming no workout, and a night', () => {
    seedWorkout('a-night', SUBJECT_DATE, null, {}, { kind: 'sleep' })
    expect(() => explainTool.run(q, { kind: 'workout', sessionId: 'nothing' })).toThrow(/no workout named 'nothing'/)
    expect(() => explainTool.run(q, { kind: 'workout', sessionId: 'a-night' })).toThrow(/no workout named 'a-night'/)
  })

  it('refuses a date or a metric, and needs a session', () => {
    seedHistory(1, { pace: 330 })
    expect(() => explainTool.run(q, { kind: 'workout', sessionId: 'run-0', localDate: SUBJECT_DATE })).toThrow(/kind 'workout' takes no localDate/)
    expect(() => explainTool.run(q, { kind: 'workout', sessionId: 'run-0', metric: 'steps' })).toThrow(/kind 'workout' takes no metric/)
    expect(() => explainTool.run(q, { kind: 'workout' })).toThrow(/kind 'workout' needs sessionId/)
    expect(() => explainTool.run(q, { kind: 'recovery', localDate: SUBJECT_DATE, sessionId: 'run-0' })).toThrow(/kind 'recovery' takes no sessionId/)
  })
})
