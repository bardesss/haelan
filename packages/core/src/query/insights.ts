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

export interface Insight {
  current: number | null
  previous: number | null
  delta: number | null
  currentDays: number
  previousDays: number
  periodDays: number
  suppressed: boolean
  reason: SuppressionReason | null
}

export function comparePeriods(input: {
  current: readonly PeriodPoint[]
  previous: readonly PeriodPoint[]
  periodDays: number
}): Insight {
  const counts = {
    currentDays: input.current.length,
    previousDays: input.previous.length,
    periodDays: input.periodDays,
  }
  const refuse = (reason: SuppressionReason): Insight => ({
    current: null, previous: null, delta: null, ...counts, suppressed: true, reason,
  })

  // Days first. A missing day has no row and therefore no coverage, so completeness is a failure
  // the second gate structurally cannot see. It is also the one a person can act on, which is
  // why it is the reason reported when both gates fail.
  const enough = (days: number) => input.periodDays > 0 && days / input.periodDays >= INSIGHT_MIN_DAY_FRACTION
  if (!enough(counts.currentDays) || !enough(counts.previousDays)) return refuse('thin-days')

  if (!observedEnough(input.current) || !observedEnough(input.previous)) return refuse('thin-coverage')

  const current = meanOf(input.current)
  const previous = meanOf(input.previous)
  return {
    current, previous, delta: current - previous, ...counts, suppressed: false, reason: null,
  }
}

const meanOf = (points: readonly PeriodPoint[]): number =>
  points.reduce((total, point) => total + point.value, 0) / points.length

/**
 * Judged only on the days that carry a coverage. A null is not a zero: it means the row was
 * never measured in hours of the day, which is true of every sleep row and every provider row.
 * A period where none of them can be judged passes, because there is nothing to judge it on.
 */
function observedEnough(points: readonly PeriodPoint[]): boolean {
  const measured = points.map((point) => point.coverage).filter((c): c is number => c !== null)
  if (measured.length === 0) return true
  const mean = measured.reduce((total, c) => total + c, 0) / measured.length
  return mean >= INSIGHT_MIN_COVERAGE
}
