import { describe, expect, it } from 'vitest'
import { comparePeriods, INSIGHT_MIN_DAY_FRACTION, INSIGHT_MIN_COVERAGE } from '../src/query/insights.ts'
import type { PeriodPoint } from '../src/query/insights.ts'

const day = (n: number, value: number, coverage: number | null = 1): PeriodPoint =>
  ({ localDate: `2026-08-${String(n).padStart(2, '0')}`, value, coverage })

const full = (from: number, value: number, coverage: number | null = 1) =>
  Array.from({ length: 7 }, (_, at) => day(from + at, value, coverage))

describe('comparePeriods', () => {
  it('reports the delta between two full periods', () => {
    const insight = comparePeriods({ current: full(8, 100), previous: full(1, 80), periodDays: 7 })
    expect(insight.current).toBeCloseTo(100, 10)
    expect(insight.previous).toBeCloseTo(80, 10)
    expect(insight.delta).toBeCloseTo(20, 10)
    expect(insight.suppressed).toBe(false)
    expect(insight.reason).toBeNull()
  })

  it('suppresses when the current period is missing too many days', () => {
    // The case the master design names: a delta computed over three missing nights is a
    // fabricated number, and no coverage value can express it because a missing day has no row.
    const insight = comparePeriods({
      current: [day(8, 100), day(9, 100), day(10, 100), day(11, 100)],
      previous: full(1, 80),
      periodDays: 7,
    })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-days')
    expect(insight.currentDays).toBe(4)
  })

  it('suppresses when the period being compared against is missing too many days', () => {
    // A complete present against a broken past is just as fabricated as the reverse.
    const insight = comparePeriods({
      current: full(8, 100),
      previous: [day(1, 80), day(2, 80)],
      periodDays: 7,
    })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-days')
  })

  it('returns nulls rather than flagged numbers when suppressed', () => {
    // Deliberately unlike a thin baseline, which is returned with its n. A thin baseline is a
    // weaker true statement; a suppressed insight is the fabricated number the design calls
    // worse than a blank card, and handing it back with a flag invites the misuse.
    const insight = comparePeriods({ current: [day(8, 100)], previous: full(1, 80), periodDays: 7 })
    expect(insight.current).toBeNull()
    expect(insight.previous).toBeNull()
    expect(insight.delta).toBeNull()
  })

  it('suppresses when the days that are present were barely observed', () => {
    const insight = comparePeriods({
      current: full(8, 100, 0.1),
      previous: full(1, 80, 1),
      periodDays: 7,
    })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-coverage')
  })

  it('checks days before coverage, so the more fundamental failure is the one reported', () => {
    // Both gates fail. Missing days is the one a person can act on, and the one that explains
    // the other, so it is the reason worth surfacing.
    const insight = comparePeriods({
      current: [day(8, 100, 0.1), day(9, 100, 0.1)],
      previous: full(1, 80, 1),
      periodDays: 7,
    })
    expect(insight.reason).toBe('thin-days')
  })

  it('treats a null coverage as present and fine rather than as zero', () => {
    // Every sleep row and every provider row carries a null coverage by design: there was never
    // a basis to measure hours of the day. Counting null as zero would blank exactly the
    // insights most worth having.
    const insight = comparePeriods({
      current: full(8, 480, null),
      previous: full(1, 420, null),
      periodDays: 7,
    })
    expect(insight.suppressed).toBe(false)
    expect(insight.delta).toBeCloseTo(60, 10)
  })

  it('judges coverage only on the days that carry one', () => {
    // A mixture: four nulls and three real, thin values. The mean is taken over the three that
    // can be judged, not over seven with nulls counted as anything.
    const mixed = [
      day(8, 100, null), day(9, 100, null), day(10, 100, null), day(11, 100, null),
      day(12, 100, 0.1), day(13, 100, 0.1), day(14, 100, 0.1),
    ]
    const insight = comparePeriods({ current: mixed, previous: full(1, 80, 1), periodDays: 7 })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-coverage')
  })

  it('does not suppress at exactly the thresholds', () => {
    // Both bounds are inclusive, matching the gap rule next door in the derive layer.
    expect(INSIGHT_MIN_DAY_FRACTION).toBe(0.7)
    expect(INSIGHT_MIN_COVERAGE).toBe(0.5)
    const fiveOfSeven = Array.from({ length: 5 }, (_, at) => day(8 + at, 100, 0.5))
    // 5/7 is 0.714, above the fraction; coverage is exactly the minimum.
    const insight = comparePeriods({
      current: fiveOfSeven,
      previous: Array.from({ length: 5 }, (_, at) => day(1 + at, 80, 0.5)),
      periodDays: 7,
    })
    expect(insight.suppressed).toBe(false)
  })

  it('suppresses a period with no days at all rather than dividing by nothing', () => {
    const insight = comparePeriods({ current: [], previous: full(1, 80), periodDays: 7 })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-days')
    expect(insight.current).toBeNull()
  })

  it('reports the day counts even when it suppresses, so a caller can say why', () => {
    const insight = comparePeriods({ current: [day(8, 100)], previous: full(1, 80), periodDays: 7 })
    expect(insight.currentDays).toBe(1)
    expect(insight.previousDays).toBe(7)
    expect(insight.periodDays).toBe(7)
  })

  it('reports the mean coverage of each period, which section 11 requires a finding to carry', () => {
    const insight = comparePeriods({
      current: full(8, 100, 0.8),
      previous: full(1, 80, 0.6),
      periodDays: 7,
    })
    expect(insight.currentCoverage).toBeCloseTo(0.8, 10)
    expect(insight.previousCoverage).toBeCloseTo(0.6, 10)
  })

  it('reports the coverage it refused on, because that is what explains the refusal', () => {
    const insight = comparePeriods({
      current: full(8, 100, 0.1),
      previous: full(1, 80, 1),
      periodDays: 7,
    })
    expect(insight.suppressed).toBe(true)
    expect(insight.currentCoverage).toBeCloseTo(0.1, 10)
    expect(insight.previousCoverage).toBeCloseTo(1, 10)
    expect(insight.delta).toBeNull()
  })

  it('reports a null coverage rather than a zero when no day carried one', () => {
    const insight = comparePeriods({
      current: full(8, 100, null),
      previous: full(1, 80, null),
      periodDays: 7,
    })
    expect(insight.currentCoverage).toBeNull()
    expect(insight.previousCoverage).toBeNull()
    expect(insight.suppressed).toBe(false)
  })

  it('averages coverage over the days that carry one, not over the period', () => {
    const mixed = [day(8, 100, 1), day(9, 100, null), day(10, 100, 0.5), ...full(11, 100, 1).slice(0, 4)]
    const insight = comparePeriods({ current: mixed, previous: full(1, 80, 1), periodDays: 7 })
    // Six measured days: 1, 0.5 and four at 1, which is 5.5 over 6.
    expect(insight.currentCoverage).toBeCloseTo(5.5 / 6, 10)
  })

  it('leaves the ranges null, because this module is given points rather than dates', () => {
    const insight = comparePeriods({ current: full(8, 100), previous: full(1, 80), periodDays: 7 })
    expect(insight.currentRange).toBeNull()
    expect(insight.previousRange).toBeNull()
  })
})
