import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION, shiftLocalDate } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { explainTool } from '../src/mcp/tools/explain.ts'
import { comparePeriods } from '../src/mcp/tools/series.ts'

interface ComparisonEvidence {
  delta: number | null
  reason: string | null
  currentFilledDays: { filled: number, of: number }
  spread: { spread: number, thin: boolean } | null
}

interface Answer { kind: string, finding: string, stoppedAt: string, walked: string[], evidence: ComparisonEvidence }

// The current period, a week; the one before it is 08-04 to 08-10.
const FROM = '2026-08-11'
const TO = '2026-08-17'
const CLAIM_WORDS = /\b(because|caused?|causes|should|recommend\w*|ready|readiness|risk\w*|advice|diagnos\w*)\b/i

describe('explain, kind comparison', () => {
  let test: TestDatabase
  let q: PersonQuery

  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'UTC' })
    q = new PersonQuery(test.db, 'robin')
  })
  afterEach(() => test.cleanup())

  function daily(localDate: string, metric: string, agg: string, value: number, coverage: number | null = 0.9): void {
    test.db.insert(schema.daily).values({
      personId: 'robin', localDate, metric, agg, source: 'merged', value, coverage, sourceMix: null, derivationVersion: DERIVATION_VERSION,
    }).run()
  }

  /**
   * Steps for the 60 days before FROM on the fixtures' sine (8000, give or take 1500, so the spread
   * is real), then `previous` for each day of the week before FROM and `current` for each of FROM to TO.
   */
  function seedSteps(o: { previous: number, current: number, currentDays?: number, currentCoverage?: number, history?: boolean, previousJitter?: number }): void {
    if (o.history !== false) {
      for (let i = 0; i < 53; i += 1) daily(shiftLocalDate(FROM, -60 + i), 'steps', 'sum', 8000 + 1500 * Math.sin(i * 0.37))
    }
    for (let i = 0; i < 7; i += 1) daily(shiftLocalDate(FROM, -7 + i), 'steps', 'sum', o.previous + (o.previousJitter ?? 0) * (i % 2 === 0 ? 1 : -1))
    for (let i = 0; i < (o.currentDays ?? 7); i += 1) daily(shiftLocalDate(FROM, i), 'steps', 'sum', o.current, o.currentCoverage ?? 0.9)
  }

  function explain(args: Record<string, unknown> = {}): Answer {
    const raw = explainTool.run(q, { kind: 'comparison', metric: 'steps', from: FROM, to: TO, ...args }) as unknown as Omit<Answer, 'evidence'> & {
      evidence: Record<string, unknown> & { comparison: ComparisonEvidence }
    }
    expect(raw.kind).toBe('comparison')
    expect(['empty', 'recovery', 'workout', 'day'].map((k) => raw.evidence[k])).toEqual([null, null, null, null])
    expect(raw.finding).not.toMatch(CLAIM_WORDS)
    expect(raw.walked.at(-1)).toBe(raw.stoppedAt)
    return { ...raw, evidence: raw.evidence.comparison }
  }

  it('stops at thinDays, and says it is not a finding of no change', () => {
    // The current week is short of days, and its steps are far above the week before, so moved
    // would answer if the gate let the walk through.
    seedSteps({ previous: 8000, current: 20000, currentDays: 3 })
    const answer = explain()
    expect(answer.stoppedAt).toBe('thinDays')
    expect(answer.walked).toEqual(['thinDays'])
    expect(answer.evidence.reason).toBe('thin-days')
    expect(answer.evidence.delta).toBeNull()
    expect(answer.evidence.spread).toBeNull()
    expect(answer.finding).toBe(
      'Not enough data to compare 2026-08-11 to 2026-08-17 against 2026-08-04 to 2026-08-10: 3 and 7 of their 7 days '
      + 'carry a reading, short of the seven in ten a period needs. This is not a finding of no change.',
    )
  })

  it('stops at thinCoverage for days too thinly observed', () => {
    seedSteps({ previous: 8000, current: 20000, currentCoverage: 0.2 })
    const answer = explain()
    expect(answer.stoppedAt).toBe('thinCoverage')
    expect(answer.finding).toContain('This is not a finding of no change.')
  })

  it('stops at spreadUnknown when there is no usual spread to judge the difference by', () => {
    // A week of history only, varying, so the spread is real but thin: the thinness alone stops it.
    seedSteps({ previous: 8000, current: 20000, history: false, previousJitter: 200 })
    const answer = explain()
    expect(answer.stoppedAt).toBe('spreadUnknown')
    expect(answer.evidence.spread?.thin).toBe(true)
    expect(answer.evidence.spread?.spread).toBeGreaterThan(0)
    expect(answer.finding).toMatch(/a difference of 1\d{4}\. There is no usual day-to-day spread thick enough to set it against/)
  })

  it('reads a difference inside the day-to-day spread as alike', () => {
    seedSteps({ previous: 8000, current: 8100 })
    const answer = explain()
    expect(answer.stoppedAt).toBe('withinSpread')
    expect(answer.finding).toMatch(/^steps averaged 8100 from 2026-08-11 to 2026-08-17, against 8000 from 2026-08-04 to 2026-08-10: a difference of 100, inside this person's usual day-to-day spread of \d+, so the two periods read alike\.$/)
  })

  it('reads a difference past the day-to-day spread as moved', () => {
    seedSteps({ previous: 8000, current: 12000 })
    const answer = explain()
    expect(answer.stoppedAt).toBe('moved')
    expect(answer.walked).toEqual(['thinDays', 'thinCoverage', 'spreadUnknown', 'withinSpread', 'moved'])
    expect(answer.finding).toContain('higher by 4000, more than this person\'s usual day-to-day spread of')
  })

  it('states filled days whichever link answers', () => {
    for (let i = 0; i < 53; i += 1) daily(shiftLocalDate(FROM, -60 + i), 'daily_hrv', 'last', 50 + 4 * Math.sin(i * 0.37), null)
    for (let i = 0; i < 7; i += 1) daily(shiftLocalDate(FROM, -7 + i), 'daily_hrv', 'last', 50, null)
    // Three of the current week's days have only the intraday hrv/mean a filled reading comes from.
    for (let i = 0; i < 7; i += 1) {
      if (i < 3) daily(shiftLocalDate(FROM, i), 'hrv', 'mean', 51, null)
      else daily(shiftLocalDate(FROM, i), 'daily_hrv', 'last', 51, null)
    }
    const answer = explain({ metric: 'daily_hrv' })
    expect(answer.evidence.currentFilledDays).toEqual({ filled: 3, of: 7 })
    expect(answer.finding).toContain('3 of the 7 days in 2026-08-11 to 2026-08-17 and 0 of the 7 before it were filled from an intraday average, not measured.')
  })

  it('takes the spread as of the first day of the period, so none of its own days sit in it', () => {
    seedSteps({ previous: 8000, current: 12000 })
    const answer = explain()
    const asOfFrom = q.baseline({ metric: 'steps', agg: 'sum', on: FROM })!.spread
    expect(answer.evidence.spread?.spread).toBe(asOfFrom)
    expect(q.baseline({ metric: 'steps', agg: 'sum', on: TO })!.spread).not.toBe(asOfFrom)
  })

  it('answers the numbers compare_periods answers', () => {
    seedSteps({ previous: 8000, current: 12000 })
    const answer = explain()
    const periods = comparePeriods.run(q, { metric: 'steps', agg: 'sum', from: FROM, to: TO }) as { delta: number }
    expect(answer.evidence.delta).toBe(periods.delta)
  })

  it('needs a metric and a range, and refuses a date', () => {
    expect(() => explainTool.run(q, { kind: 'comparison', metric: 'steps', from: FROM })).toThrow(/kind 'comparison' needs to/)
    expect(() => explainTool.run(q, { kind: 'comparison', metric: 'steps', from: FROM, to: TO, localDate: FROM })).toThrow(/kind 'comparison' takes no localDate/)
    expect(() => explainTool.run(q, { kind: 'empty', metric: 'steps', localDate: FROM, from: FROM })).toThrow(/kind 'empty' takes no from/)
  })
})
