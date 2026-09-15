import { describe, it, expect } from 'vitest'
import { cadenceOf } from '../src/api/sourceCadence.ts'

/** `days` dates from `from`, one every `everyDays` (default consecutive). */
const dates = (from: string, days: number, everyDays = 1): string[] => {
  const start = Date.parse(`${from}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * everyDays * 86_400_000).toISOString().slice(0, 10))
}

describe('cadenceOf', () => {
  it('calls a daily source silent past its own floor stale', () => {
    expect(cadenceOf(dates('2026-01-01', 20), '2026-02-09')).toMatchObject({
      reportingDates: 20, medianGapDays: 1, lastReportedDate: '2026-01-20',
      status: 'stale', reportingNow: false,
    })
  })

  it('spares a monthly source silent well inside its own gap', () => {
    // Above the flat floor and below four of its own gaps, which is the only silence that can
    // tell a relative rule from a fixed one.
    expect(cadenceOf(dates('2025-01-01', 14, 31), '2026-03-20')).toMatchObject({
      status: 'reporting', reportingNow: true,
    })
  })

  it('does not judge a source with too little history', () => {
    expect(cadenceOf(dates('2025-01-01', 13), '2026-09-01')).toMatchObject({
      status: 'unjudged', reportingNow: false,
    })
  })

  it('answers for no dates at all rather than throwing', () => {
    expect(cadenceOf([], '2026-01-01')).toEqual({
      lastReportedDate: null, reportingDates: 0, medianGapDays: null,
      status: 'unjudged', reportingNow: false,
    })
  })

  it('takes the dates in whatever order it is handed them', () => {
    // The database read hands these over sorted; a caller assembling them from a chart's points
    // has no such guarantee, and a last-reported date read off an unsorted array is wrong
    // silently rather than loudly.
    const shuffled = [...dates('2026-01-01', 20)].reverse()
    expect(cadenceOf(shuffled, '2026-01-21')).toMatchObject({
      lastReportedDate: '2026-01-20', medianGapDays: 1, status: 'reporting',
    })
  })

  it('ignores a date repeated by two metrics on the same day', () => {
    // A chart's points carry one entry per metric per day, so the same date arrives more than
    // once. Counted twice it would inflate reportingDates past the history gate and invent a
    // zero gap, which the floor would then have to rescue.
    const doubled = [...dates('2026-01-01', 13), ...dates('2026-01-01', 13)]
    expect(cadenceOf(doubled, '2026-01-14')).toMatchObject({
      reportingDates: 13, medianGapDays: 1, status: 'unjudged',
    })
  })
})
