import { describe, it, expect } from 'vitest'
import { cadenceOf, continuedElsewhere, routineMetrics } from '../src/api/sourceCadence.ts'
import type { SourceReport } from '../src/api/sourceCadence.ts'

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

describe('routineMetrics', () => {
  const reports = (source: string, metric: string, on: readonly string[]): SourceReport[] =>
    on.map((date) => ({ source, date, metric }))

  it("keeps a metric reported on at least half of the source's dates in its window, and drops one below half", () => {
    // Four reporting dates in the window: two is half (kept), one is a quarter (dropped).
    const window = dates('2026-01-07', 4)
    const rows = [
      ...reports('s-watch', 'steps', window),
      ...reports('s-watch', 'heart_rate', window.slice(0, 2)),
      ...reports('s-watch', 'workout_count', window.slice(0, 1)),
    ]
    expect(routineMetrics('s-watch', '2026-01-10', rows)).toEqual(['heart_rate', 'steps'])
  })

  it('reads the ROUTINE_WINDOW_DAYS ending on the last date, both ends included, and nothing outside it', () => {
    // Last date the 10th, so the window is the 4th through the 10th. A metric seen only on the
    // 3rd is outside it, one seen only after the 10th is not the source's own history yet, and
    // neither counts towards the reporting dates the half is taken of.
    const rows = [
      ...reports('s-watch', 'steps', ['2026-01-04', '2026-01-10']),
      ...reports('s-watch', 'heart_rate', ['2026-01-04']),
      ...reports('s-watch', 'weight', ['2026-01-03', '2026-01-02', '2026-01-01']),
      ...reports('s-watch', 'body_fat', ['2026-01-11', '2026-01-12']),
    ]
    expect(routineMetrics('s-watch', '2026-01-10', rows)).toEqual(['heart_rate', 'steps'])
  })

  it('ignores every other source', () => {
    const rows = [
      ...reports('s-watch', 'steps', ['2026-01-10']),
      ...reports('s-phone', 'heart_rate', ['2026-01-10']),
    ]
    expect(routineMetrics('s-watch', '2026-01-10', rows)).toEqual(['steps'])
  })

  it('is what continuedElsewhere requires to carry on, and it reads a one-shot iterable', () => {
    // A generator can be walked once. continuedElsewhere walks the reports for the routine list
    // and again for what arrived since, so it must materialise them first.
    function* rows(): Generator<SourceReport> {
      yield* reports('s-old', 'steps', ['2026-01-10'])
      yield* reports('s-new', 'steps', ['2026-01-11'])
    }
    expect(continuedElsewhere('s-old', '2026-01-10', rows())).toBe(true)
  })
})
