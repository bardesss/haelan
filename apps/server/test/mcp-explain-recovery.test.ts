import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { and, eq, gt, lte } from 'drizzle-orm'
import { PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION, shiftLocalDate } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { recoveryWindowStart, RECOVERY_METRIC_SOURCES } from '@haelan/core/recovery-index'
import type { RecoveryMetricSource } from '@haelan/core/recovery-index'
import { explainTool } from '../src/mcp/tools/explain.ts'
import { recoveryIndexTool } from '../src/mcp/tools/recovery.ts'

interface RecoveryEvidence {
  enough: boolean
  missing: string[] | null
  score: number | null
  band: string | null
  degraded: string[] | null
  dayHrvFilled: boolean | null
  hrvFilled: { filled: number, of: number }
  carriedBy: string | null
  pulledAgainst: string[] | null
  hrvRun: { side: string, days: number, capped: boolean, since: string, sideNights: number, filledDays: number } | null
}

interface Answer { kind: string, finding: string, stoppedAt: string, walked: string[], evidence: RecoveryEvidence }

const D = '2026-08-10'

// The same claim words mcp-explain.test.ts checks every empty answer against.
const CLAIM_WORDS = /\b(because|caused?|causes|should|recommend\w*|ready|readiness|risk\w*|advice|diagnos\w*)\b/i

type Key = RecoveryMetricSource['key']

// Centres and wobble as mcp-fixtures.ts's insertRecoverySeries uses them, and for its reason: a
// sine not aligned with the sleep week keeps every baseline's spread real, so a spike on D scores
// as a finite, reproducible number rather than an infinite z.
const USUAL: Record<Key, { centre: number, amplitude: number }> = {
  hrv: { centre: 50, amplitude: 4 },
  restingHeartRate: { centre: 55, amplitude: 4 },
  respiratoryRate: { centre: 14, amplitude: 1 },
  asleepMinutes: { centre: 420, amplitude: 15 },
  bedtimeMinutes: { centre: 1380, amplitude: 15 },
}

describe('explain, kind recovery', () => {
  let test: TestDatabase
  let q: PersonQuery

  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
    q = new PersonQuery(test.db, 'robin')
  })
  afterEach(() => test.cleanup())

  function daily(localDate: string, metric: string, agg: string, value: number): void {
    test.db.insert(schema.daily).values({
      personId: 'robin', localDate, metric, agg, source: 'merged', value, coverage: null, sourceMix: null,
      derivationVersion: DERIVATION_VERSION,
    }).run()
  }

  /**
   * Every recovery input from the start of D's window through D. `on` overrides an input's value
   * on D itself, `without` leaves an input out entirely, and `hrvFilledOn` writes those days' HRV
   * only as the intraday `hrv/mean` a filled reading comes from, never as `daily_hrv`.
   */
  function seed(opts: { on?: Partial<Record<Key, number>>, without?: Key[], hrvFilledOn?: string[] } = {}): void {
    let i = 0
    for (let date = recoveryWindowStart(D); date <= D; date = shiftLocalDate(date, 1)) {
      for (const { key, metric, agg } of RECOVERY_METRIC_SOURCES) {
        if (opts.without?.includes(key)) continue
        const { centre, amplitude } = USUAL[key]
        const value = date === D && opts.on?.[key] !== undefined ? opts.on[key]! : centre + amplitude * Math.sin(i * 0.37)
        if (key === 'hrv' && opts.hrvFilledOn?.includes(date)) daily(date, 'hrv', 'mean', value)
        else daily(date, metric, agg, value)
      }
      i += 1
    }
  }

  function explain(args: Record<string, unknown> = {}): Answer {
    const raw = explainTool.run(q, { kind: 'recovery', localDate: D, ...args }) as Omit<Answer, 'evidence'> & {
      evidence: { empty: unknown, recovery: RecoveryEvidence }
    }
    expect(raw.kind).toBe('recovery')
    expect(raw.evidence.empty).toBeNull()
    expect(raw.finding).not.toMatch(CLAIM_WORDS)
    expect(raw.walked.at(-1)).toBe(raw.stoppedAt)
    return { ...raw, evidence: raw.evidence.recovery }
  }

  it('stops at withheld, not hrvFilledToday, on a day that could not be scored', () => {
    // HRV is there and filled on D, so hrvFilledToday would answer; resting heart rate is not, so
    // the day is withheld first, and a withheld day is not a low score.
    seed({ without: ['restingHeartRate'], hrvFilledOn: [D] })
    const answer = explain()
    expect(answer.stoppedAt).toBe('withheld')
    expect(answer.walked).toEqual(['withheld'])
    expect(answer.evidence.missing).toEqual(['restingHeartRate'])
    expect(answer.evidence.score).toBeNull()
    expect(answer.finding).toContain('withheld day, not a low score')
  })

  it('stops at hrvFilledToday before reading the inputs when the day\'s own HRV is filled', () => {
    // A spiked HRV takes the score out of the usual band, so carriedBy would answer too.
    seed({ on: { hrv: 70 }, hrvFilledOn: [D] })
    const answer = explain()
    expect(answer.stoppedAt).toBe('hrvFilledToday')
    expect(answer.walked).not.toContain('carriedBy')
    expect(answer.evidence.dayHrvFilled).toBe(true)
    expect(answer.evidence.carriedBy).toBeNull()
    expect(answer.finding).toContain('not a measurement throughout')
  })

  it('stops at usual when the score sits within the person\'s own normal', () => {
    seed()
    const answer = explain()
    expect(answer.evidence.band).toBe('usual')
    expect(answer.stoppedAt).toBe('usual')
    expect(answer.walked).toEqual(['withheld', 'hrvFilledToday', 'usual'])
    expect(answer.evidence.carriedBy).toBeNull()
  })

  it('names the input that lifted the score most', () => {
    seed({ on: { hrv: 60 } })
    const answer = explain()
    expect(answer.stoppedAt).toBe('carriedBy')
    expect(answer.evidence.carriedBy).toBe('hrv')
    expect(answer.finding).toMatch(/Heart rate variability lifted it most, \+\d+\.\d of the \d+ points between the score and 50\./)
  })

  it('names the input that lowered the score most', () => {
    seed({ on: { restingHeartRate: 75 } })
    const answer = explain()
    expect(answer.evidence.score).toBeLessThan(50)
    expect(answer.evidence.carriedBy).toBe('restingHeartRate')
    expect(answer.finding).toMatch(/Resting heart rate lowered it most, -\d+\.\d of the \d+ points/)
  })

  it('says so when an input pulled the other way, and that the inputs do not add up', () => {
    // The sine leaves the week's sleep a little under its usual on D, so it pulls against the score\n    // too: the sentence names both, capitalised at the start, in the order the inputs are listed.
    seed({ on: { hrv: 62, restingHeartRate: 60 } })
    const answer = explain()
    expect(answer.evidence.carriedBy).toBe('hrv')
    expect(answer.evidence.pulledAgainst).toEqual(['restingHeartRate', 'sleep'])
    expect(answer.finding).toMatch(/ Resting heart rate and the past week's sleep pulled the other way \(-\d+\.\d, -\d+\.\d\), so the inputs do not add up to the distance from 50\./)
  })

  it('names the input that carried the score\'s direction, not the largest pull overall', () => {
    // Found by probing: the score lands at 32, in the below band, with HRV the single largest
    // input (+7.0) pulling UP against it and resting heart rate (-7.0) the largest pulling down.
    seed({ on: { hrv: 56, restingHeartRate: 62, respiratoryRate: 17 } })
    const answer = explain()
    expect(answer.evidence.band).toBe('below')
    expect(answer.evidence.carriedBy).toBe('restingHeartRate')
    expect(answer.evidence.pulledAgainst).toEqual(['hrv'])
    expect(answer.finding).toContain('Resting heart rate lowered it most')
  })

  it('does not name a pull that prints as 0.0', () => {
    // Found by probing: breathing rate a hair above its usual gives it -0.025 points on a score of
    // 83, which the sentence would print as -0.0. Resting heart rate and sleep pull against HRV for real.
    seed({ on: { hrv: 60, restingHeartRate: 58, respiratoryRate: 13.96 } })
    const answer = explain()
    expect(answer.evidence.carriedBy).toBe('hrv')
    expect(answer.evidence.pulledAgainst).toEqual(['restingHeartRate', 'sleep'])
    expect(answer.finding).not.toContain('breathing rate')
    expect(answer.finding).not.toContain('0.0')
  })

  it('counts filled HRV in the baseline without counting the day\'s own', () => {
    seed({ on: { hrv: 70 }, hrvFilledOn: [D, shiftLocalDate(D, -3)] })
    const answer = explain()
    expect(answer.stoppedAt).toBe('hrvFilledToday')
    expect(answer.evidence.hrvFilled.filled).toBe(2)
    expect(answer.finding).toContain('1 of the HRV readings in its baseline was filled')
  })

  it('states an absent input whichever link answers', () => {
    seed({ without: ['respiratoryRate'] })
    const answer = explain()
    expect(answer.stoppedAt).toBe('usual')
    expect(answer.evidence.degraded).toEqual(['respiratoryRate'])
    expect(answer.finding).toContain('computed without breathing rate; that weight went to the other inputs')
  })

  it('states filled HRV inside the baseline without stopping on it', () => {
    seed({ on: { hrv: 70 }, hrvFilledOn: [shiftLocalDate(D, -3), shiftLocalDate(D, -9)] })
    const answer = explain()
    expect(answer.stoppedAt).toBe('carriedBy')
    expect(answer.evidence.dayHrvFilled).toBe(false)
    expect(answer.evidence.hrvFilled.filled).toBe(2)
    expect(answer.finding).toContain('2 of the HRV readings in its baseline were filled from an intraday average, not measured')
  })

  it('answers the number recovery_index answers for the same day', () => {
    seed({ on: { hrv: 70, restingHeartRate: 60 } })
    const answer = explain()
    const index = recoveryIndexTool.run(q, { from: D, to: D }) as { days: { score: number, band: string }[], hrvFilled: unknown }
    expect(answer.evidence.score).toBe(index.days[0]!.score)
    expect(answer.evidence.band).toBe(index.days[0]!.band)
    expect(answer.evidence.hrvFilled).toEqual(index.hrvFilled)
  })

  describe('a stretch of HRV away from its usual', () => {
    /** Sets the daily HRV from `first` days before D through `last` days before D (0 is D itself). */
    function hrvStretch(first: number, last: number, value: number): void {
      test.db.update(schema.daily).set({ value }).where(and(
        eq(schema.daily.metric, 'daily_hrv'),
        gt(schema.daily.localDate, shiftLocalDate(D, -first - 1)), lte(schema.daily.localDate, shiftLocalDate(D, -last)),
      )).run()
    }

    it('is named when HRV lowered a score below 50 and the stretch is below', () => {
      seed({ on: { hrv: 30 } })
      hrvStretch(9, 1, 30)
      const answer = explain()
      expect(answer.evidence.score).toBeLessThan(50)
      expect(answer.evidence.carriedBy).toBe('hrv')
      expect(answer.evidence.hrvRun).toEqual({ side: 'below', days: 9, capped: false, since: '2026-08-02', sideNights: 7, filledDays: 0 })
      expect(answer.finding).toBe('The recovery index on 2026-08-10 is 28, in the below band. Heart rate variability lowered it most, -16.3 of the 22 points between the score and 50. Resting heart rate pulled the other way (+5.4), so the inputs do not add up to the distance from 50. HRV\'s seven-day average has been below its usual for 9 measured days, since 2026-08-02; 7 of the last 7 nights were low.')
    })

    it('is not named when resting heart rate carried the score', () => {
      seed({ on: { restingHeartRate: 75 } })
      hrvStretch(9, 1, 30)
      const answer = explain()
      expect(answer.evidence.carriedBy).toBe('restingHeartRate')
      expect(answer.evidence.hrvRun?.side).toBe('below')
      expect(answer.finding).not.toContain('seven-day average')
    })

    it('is not named when the stretch is above and HRV lowered the score', () => {
      seed({ on: { hrv: 30 } })
      hrvStretch(9, 1, 70)
      const answer = explain()
      expect(answer.evidence.score).toBeLessThan(50)
      expect(answer.evidence.carriedBy).toBe('hrv')
      expect(answer.evidence.hrvRun?.side).toBe('above')
      expect(answer.finding).not.toContain('seven-day average')
    })

    it('is null in the evidence on a withheld day', () => {
      seed({ without: ['restingHeartRate'] })
      hrvStretch(9, 1, 30)
      expect(explain().evidence.hrvRun).toBeNull()
    })
  })

  it('refuses a metric, an agg or a source rather than ignoring them', () => {
    seed()
    for (const extra of [{ metric: 'steps' }, { agg: 'sum' }, { source: 'merged' }]) {
      expect(() => explainTool.run(q, { kind: 'recovery', localDate: D, ...extra })).toThrow(/kind 'recovery' takes no/)
    }
  })

  it('refuses kind empty without a metric', () => {
    expect(() => explainTool.run(q, { kind: 'empty', localDate: D })).toThrow(/kind 'empty' needs metric/)
  })
})
