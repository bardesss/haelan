/**
 * A period against the one before it, or a refusal.
 *
 * The master design is explicit that an insight computed over missing days is a fabricated
 * number and that fabricated numbers are worse than a blank card. So this reports a delta only
 * when it can stand behind it, and returns nulls with a reason when it cannot.
 */

/** How much of a period must carry a value at all. Five days of seven clears it. */
export const INSIGHT_MIN_DAY_FRACTION = 0.7

/** How well observed the days that are present must be, on average, where they say. */
export const INSIGHT_MIN_COVERAGE = 0.5

export interface PeriodPoint {
  localDate: string
  value: number
  /** Null where there was never a basis to measure hours: a sleep row or a provider row. */
  coverage: number | null
}

export type SuppressionReason = 'thin-days' | 'thin-coverage'

/** An inclusive range of local dates. */
export interface DateRange {
  from: string
  to: string
}

export interface Insight {
  current: number | null
  previous: number | null
  delta: number | null
  currentDays: number
  previousDays: number
  periodDays: number
  /**
   * Mean coverage over the days that carry one, which section 11 requires a finding to be
   * reported with. Null where none of the days could be judged on coverage at all, which is
   * not a zero: it means the question does not apply to this metric.
   */
  currentCoverage: number | null
  previousCoverage: number | null
  /**
   * The two ranges compared. Null here, because this module is given points rather than dates.
   * PersonQuery fills them in from the arithmetic it already did, so no caller has to grow its
   * own copy of "the period before this one" in order to say what it compared against.
   */
  currentRange: DateRange | null
  previousRange: DateRange | null
  suppressed: boolean
  reason: SuppressionReason | null
}

export function comparePeriods(input: {
  current: readonly PeriodPoint[]
  previous: readonly PeriodPoint[]
  periodDays: number
}): Insight {
  // Everything that explains the answer, computed before either gate, because a refusal has to
  // come back carrying its own evidence or a caller cannot say why it refused.
  const facts = {
    currentDays: input.current.length,
    previousDays: input.previous.length,
    periodDays: input.periodDays,
    currentCoverage: meanCoverageOf(input.current),
    previousCoverage: meanCoverageOf(input.previous),
    currentRange: null,
    previousRange: null,
  }
  const refuse = (reason: SuppressionReason): Insight => ({
    current: null, previous: null, delta: null, ...facts, suppressed: true, reason,
  })

  // Days first. A missing day has no row and therefore no coverage, so completeness is a failure
  // the second gate structurally cannot see. It is also the one a person can act on, which is
  // why it is the reason reported when both gates fail.
  const enough = (days: number) => input.periodDays > 0 && days / input.periodDays >= INSIGHT_MIN_DAY_FRACTION
  if (!enough(facts.currentDays) || !enough(facts.previousDays)) return refuse('thin-days')

  if (!observedEnough(facts.currentCoverage) || !observedEnough(facts.previousCoverage)) {
    return refuse('thin-coverage')
  }

  const current = meanOf(input.current)
  const previous = meanOf(input.previous)
  return {
    current, previous, delta: current - previous, ...facts, suppressed: false, reason: null,
  }
}

const meanOf = (points: readonly PeriodPoint[]): number =>
  points.reduce((total, point) => total + point.value, 0) / points.length

/**
 * Averaged only over the days that carry a coverage. A null is not a zero: it means the row was
 * never measured in hours of the day, which is true of every sleep row, every provider row, and
 * every metric whose coverage is not a quality signal. Null when none of them carry one.
 */
function meanCoverageOf(points: readonly PeriodPoint[]): number | null {
  const measured = points.map((point) => point.coverage).filter((c): c is number => c !== null)
  if (measured.length === 0) return null
  return measured.reduce((total, c) => total + c, 0) / measured.length
}

/** A period with nothing to judge passes, because there is nothing to judge it on. */
function observedEnough(mean: number | null): boolean {
  return mean === null || mean >= INSIGHT_MIN_COVERAGE
}
