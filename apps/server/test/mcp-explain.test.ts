import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION, shiftLocalDate,
  dayMetricTarget, sessionTarget,
} from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { explainTool } from '../src/mcp/tools/explain.ts'
import { insertSession } from './mcp-fixtures.ts'

interface Answer {
  kind: string
  finding: string
  stoppedAt: string
  walked: string[]
  evidence: Record<string, unknown>
}

const D = '2026-08-10'
const H = 3_600_000

// Words that would turn a finding about the data into a claim about the person: a cause, advice,
// a readiness verdict or a risk. Every answer this file gets back is checked against them.
const CLAIM_WORDS = /\b(because|caused?|causes|should|recommend\w*|ready|readiness|risk\w*|advice|diagnos\w*)\b/i

describe('explain, kind empty', () => {
  let test: TestDatabase
  let q: PersonQuery

  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
    test.db.insert(schema.sources).values({
      id: 'robin-watch', personId: 'robin', externalId: 'robin-watch', displayName: 'robin-watch', kind: 'device', createdAtMs: 0,
    }).run()
    q = new PersonQuery(test.db, 'robin')
  })
  afterEach(() => test.cleanup())

  function daily(localDate: string, metric: string, agg: string, value: number, source = 'merged'): void {
    test.db.insert(schema.daily).values({
      personId: 'robin', localDate, metric, agg, source, value, coverage: 0.9, sourceMix: null,
      derivationVersion: DERIVATION_VERSION,
    }).run()
  }

  function stepsFor(days: number, endingOn: string): void {
    for (let i = 0; i < days; i += 1) daily(shiftLocalDate(endingOn, -i), 'steps', 'sum', 6000 + (i % 7) * 400)
  }

  function exclude(scope: 'day_metric' | 'session', targetKey: string): void {
    test.db.insert(schema.overrides).values({
      id: `o-${targetKey}`, personId: 'robin', scope, targetKey, action: 'exclude', reason: 'test', createdAtMs: 0,
    }).run()
  }

  function explain(args: { metric: string, localDate?: string, agg?: string, source?: string }): Answer {
    const answer = explainTool.run(q, { kind: 'empty', localDate: D, ...args }) as Answer
    expect(answer.kind).toBe('empty')
    expect(answer.finding).not.toMatch(CLAIM_WORDS)
    // The walk stops where it says it stopped: the last link walked is the one that answered.
    expect(answer.walked.at(-1)).toBe(answer.stoppedAt)
    return answer
  }

  it('stops at present when there is a reading with a baseline to stand on', () => {
    stepsFor(70, D)
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('present')
    expect(answer.walked).toEqual(['thinBaseline', 'present'])
    expect(answer.evidence['value']).toBe(6000)
    expect(answer.evidence['filled']).toBe(false)
    expect((answer.evidence['baseline'] as { thin: boolean }).thin).toBe(false)
  })

  it('stops at thinBaseline, not present, when the reading has too little history behind it', () => {
    daily(D, 'steps', 'sum', 6000)
    daily(shiftLocalDate(D, -1), 'steps', 'sum', 7000)
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('thinBaseline')
    expect(answer.walked).toEqual(['thinBaseline'])
    expect(answer.finding).toContain('only 1 earlier day stands')
    expect(answer.finding).toContain('not evidence of nothing')
  })

  it('says a filled reading is filled, in words', () => {
    // daily_hrv has no row, so the reading is hrv/mean standing in for it.
    daily(D, 'hrv', 'mean', 44)
    const answer = explain({ metric: 'daily_hrv' })
    expect(answer.evidence['filled']).toBe(true)
    expect(answer.finding).toContain('filled from the day\'s intraday average, not measured')
  })

  it('stops at dayMetricExcluded before the day is judged empty', () => {
    // Steps before and after, so afterLastReport cannot answer; nothing else that day, so
    // nothingThatDay would. The hand exclusion is the more specific account and comes first.
    daily(shiftLocalDate(D, -1), 'steps', 'sum', 6000)
    daily(shiftLocalDate(D, 1), 'steps', 'sum', 6000)
    exclude('day_metric', dayMetricTarget({ localDate: D, metric: 'steps' }))
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('dayMetricExcluded')
    expect(answer.walked).not.toContain('nothingThatDay')
    expect(answer.evidence['excludedMetrics']).toEqual(['steps'])
    expect(answer.evidence['dayHasOtherData']).toBeNull()
  })

  it('stops at sessionExcluded for a sleep metric whose night was excluded', () => {
    const start = Date.UTC(2026, 7, 9, 22)
    insertSession(test.db, 'night', 'robin', 'robin-watch', 'sleep', start, start + 8 * H, D)
    exclude('session', sessionTarget('night'))
    const answer = explain({ metric: 'sleep_asleep_minutes' })
    expect(answer.stoppedAt).toBe('sessionExcluded')
    expect(answer.evidence['excludedSleepSessions']).toEqual(['night'])
    expect(answer.walked).not.toContain('neverReported')
  })

  it('does not blame an excluded nap for a night that was never recorded', () => {
    // The source said this afternoon session was not the main sleep, so put back it would still
    // have been no night: its exclusion is not why the night is missing.
    const start = Date.UTC(2026, 7, 10, 13)
    insertSession(test.db, 'nap', 'robin', 'robin-watch', 'sleep', start, start + H, D, { mainSleep: false })
    exclude('session', sessionTarget('nap'))
    daily(shiftLocalDate(D, -1), 'sleep_asleep_minutes', 'sum', 450)
    const answer = explain({ metric: 'sleep_asleep_minutes' })
    expect(answer.walked).toContain('sessionExcluded')
    expect(answer.stoppedAt).not.toBe('sessionExcluded')
    expect(answer.evidence['excludedSleepSessions']).toEqual([])
  })

  it('stops at nightFiledUnderMorning when the night that began that evening is filed under the next day', () => {
    // The night starts on the evening of D and is filed under D + 1. D itself has nothing at all,
    // so nothingThatDay would also answer - it must not be walked.
    const start = Date.UTC(2026, 7, 10, 22)
    insertSession(test.db, 'late-night', 'robin', 'robin-watch', 'sleep', start, start + 8 * H, shiftLocalDate(D, 1))
    daily(shiftLocalDate(D, 1), 'sleep_asleep_minutes', 'sum', 450)
    const answer = explain({ metric: 'sleep_asleep_minutes' })
    expect(answer.stoppedAt).toBe('nightFiledUnderMorning')
    expect(answer.evidence['nightFiledUnder']).toBe('2026-08-11')
    expect(answer.walked).not.toContain('nothingThatDay')
    expect(answer.finding).toContain('filed under 2026-08-11, the morning it ended on')
  })

  it('does not walk the sleep links for a metric that is not read from a night', () => {
    daily(shiftLocalDate(D, -1), 'steps', 'sum', 6000)
    const answer = explain({ metric: 'steps' })
    expect(answer.evidence['excludedSleepSessions']).toBeNull()
    expect(answer.evidence['nightFiledUnder']).toBeNull()
  })

  it('stops at otherSource when the source asked for has no row and the day does', () => {
    daily(D, 'steps', 'sum', 6000, 'provider')
    const answer = explain({ metric: 'steps', source: 'merged' })
    expect(answer.stoppedAt).toBe('otherSource')
    expect(answer.evidence['daySource']).toBe('provider')
    expect(answer.finding).toBe('merged has no steps reading on 2026-08-10, but the day does, reconciled as provider.')
  })

  it('stops at neverReported when nothing has ever reported the metric', () => {
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('neverReported')
    expect(answer.walked).not.toContain('nothingThatDay')
  })

  it('stops at beforeFirstReport for a day before the first reading', () => {
    daily('2026-09-01', 'steps', 'sum', 6000)
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('beforeFirstReport')
    expect(answer.evidence['firstReportedAfter']).toBe('2026-09-01')
  })

  it('stops at afterLastReport for a day after the last reading, before asking about the day itself', () => {
    daily('2026-07-01', 'steps', 'sum', 6000)
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('afterLastReport')
    expect(answer.finding).toBe('Nothing has reported steps since 2026-07-01.')
    expect(answer.walked).not.toContain('nothingThatDay')
  })

  it('stops at nothingThatDay when the whole day is missing', () => {
    daily(shiftLocalDate(D, -1), 'steps', 'sum', 6000)
    daily(shiftLocalDate(D, 1), 'steps', 'sum', 6000)
    const answer = explain({ metric: 'steps' })
    expect(answer.stoppedAt).toBe('nothingThatDay')
    expect(answer.evidence['dayHasOtherData']).toBe(false)
  })

  it('ends at notReportedThatDay when other readings arrived and this one did not', () => {
    daily(shiftLocalDate(D, -1), 'resting_heart_rate', 'last', 55)
    daily(shiftLocalDate(D, 1), 'resting_heart_rate', 'last', 55)
    daily(D, 'steps', 'sum', 6000)
    const answer = explain({ metric: 'resting_heart_rate' })
    expect(answer.stoppedAt).toBe('notReportedThatDay')
    expect(answer.walked).toHaveLength(11)
    expect(answer.evidence['dayHasOtherData']).toBe(true)
  })

  it('refuses a metric that is not in the catalogue rather than explaining its absence', () => {
    expect(() => explainTool.run(q, { kind: 'empty', metric: 'not_a_metric', localDate: D })).toThrow(/not_a_metric/)
  })
})
