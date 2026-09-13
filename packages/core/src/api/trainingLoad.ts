import { shiftLocalDate } from '../derive/localDay.ts'

/**
 * One observed day's cardio load.
 *
 * A day nobody wore a watch is ABSENT from the list, not present with a zero. That distinction is
 * not a convention this module invents, it is one the derive already guarantees: `edwardsLoad`
 * answers null only when every zone is absent, and `deriveCardioLoadDay` then writes no row, while
 * a watch worn by somebody who did not move records zeros and so writes a row holding 0. A row's
 * existence is the wear signal, which is what lets everything below count worn days without a
 * second coverage query that could disagree with the first.
 */
export interface LoadDay {
  localDate: string
  load: number
}

/**
 * Not enough worn days to answer. Carries the counts anyway, so the card can say how far off it is
 * rather than "no data", which is indistinguishable from "this feature is broken".
 */
export interface TrainingLoadUnavailable {
  enough: false
  wornAcute: number
  wornChronic: number
}

export interface TrainingLoadAvailable {
  enough: true
  /** Weekly equivalent load over the acute window. */
  acute: number
  /** Weekly equivalent load over the chronic window. Also the derived weekly target. */
  chronic: number
  /**
   * acute / chronic. Null when the chronic load is zero, which is a watch worn across the whole
   * window by somebody who never left the resting zone: the loads are still real numbers and worth
   * showing, but "against your usual" has no usual to divide by.
   */
  ratio: number | null
  wornAcute: number
  wornChronic: number
  /**
   * The weekly target, derived rather than typed, and equal to the chronic load by construction.
   * That equality is the point: this week's load against its target is the same statement as the
   * ratio, so the person is not asked for a number the archive cannot validate and there is one
   * coverage gate rather than two.
   */
  target: number
}

/**
 * A union rather than `TrainingLoad | null` so a caller cannot read a load without having passed
 * the coverage gate first, and so the unavailable case still carries something worth rendering.
 */
export type TrainingLoad = TrainingLoadUnavailable | TrainingLoadAvailable

export const ACUTE_DAYS = 7
export const CHRONIC_DAYS = 28

/**
 * How many worn days each window needs before it will answer at all.
 *
 * Both windows below are extrapolations: a mean over worn days, times seven. These are what bound
 * the extrapolation, and they are proposals rather than derived truths. ACWR's literature assumes a
 * compliant athlete under continuous observation, and a household archive is not that, so the
 * conventional answer ("28 days") is not available and some floor has to be picked. Half the
 * chronic window, and four of seven acute days, are the arguable numbers chosen; argue with them
 * here rather than by discovering them inline.
 */
export const MIN_WORN_ACUTE = 4
export const MIN_WORN_CHRONIC = 14

/**
 * The first local date of the chronic window ending `endDate`.
 *
 * Exported so a caller fetching the series asks for exactly the span `trainingLoad` will read. A
 * caller computing its own start can quietly ask for 27 days or 29 and still get an answer, and
 * the worn day counts the floors are judged against would then be measuring a window nobody chose.
 */
export function chronicWindowStart(endDate: string): string {
  return shiftLocalDate(endDate, -(CHRONIC_DAYS - 1))
}

/**
 * Acute and chronic cardio load, and the ratio between them, over the windows ending `endDate`.
 *
 * Both windows are the SAME statistic over different spans: the mean daily load across the worn
 * days in the window, times seven, so both read as a weekly equivalent load and the ratio compares
 * like with like.
 *
 * Averaging over worn days rather than calendar days is the whole reason this is not a sum. A sum
 * understates any window holding a gap, and understating the ACUTE window specifically answers
 * "you have detrained" for somebody who trained without wearing the watch, which is the most
 * misleading thing this calculation could say. Counting worn days in the denominator costs the
 * ability to distinguish a rest week from an unworn one, which the archive genuinely cannot tell
 * apart, and says so by refusing below the floors above rather than by guessing.
 *
 * Dates are compared as text. `YYYY-MM-DD` sorts lexicographically, so a window test needs no
 * parsing and no timezone question, the same reason `ageAt` compares `MM-DD` directly.
 */
export function trainingLoad(
  days: readonly LoadDay[],
  endDate: string,
): TrainingLoad {
  const acuteFrom = shiftLocalDate(endDate, -(ACUTE_DAYS - 1))
  const chronicFrom = chronicWindowStart(endDate)

  let acuteSum = 0
  let chronicSum = 0
  let wornAcute = 0
  let wornChronic = 0
  for (const day of days) {
    if (day.localDate < chronicFrom || day.localDate > endDate) continue
    chronicSum += day.load
    wornChronic += 1
    if (day.localDate < acuteFrom) continue
    acuteSum += day.load
    wornAcute += 1
  }

  if (wornAcute < MIN_WORN_ACUTE || wornChronic < MIN_WORN_CHRONIC) {
    return { enough: false, wornAcute, wornChronic }
  }

  const acute = (acuteSum / wornAcute) * ACUTE_DAYS
  const chronic = (chronicSum / wornChronic) * ACUTE_DAYS
  return {
    enough: true,
    acute,
    chronic,
    ratio: chronic === 0 ? null : acute / chronic,
    wornAcute,
    wornChronic,
    target: chronic,
  }
}
