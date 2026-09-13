// Haelan's own cardio load. Google Health shows one and the v4 API exposes no data type for it,
// so this is the same model family (TRIMP, training impulse) on its own scale, never Google's
// integer - their coefficients are unpublished. Every surface that prints a number from here says
// whose number it is.
//
// It imports nothing from ../db/ and must not start. apps/web reaches it through the
// `@haelan/core/cardio-load` subpath rather than the root barrel, and the root barrel pulls
// better-sqlite3, which cannot enter a browser bundle. Same rule as api/workoutSummary.ts.

export interface ZoneMinutes {
  lightMinutes: number | null
  moderateMinutes: number | null
  vigorousMinutes: number | null
  peakMinutes: number | null
}

// 1, 2, 3, 4 by zone rank. Edwards' own weights, unchanged.
const EDWARDS_WEIGHTS = [1, 2, 3, 4] as const

/**
 * Edwards TRIMP: one weight per heart rate zone, times the minutes spent in it.
 *
 * Needs no profile data at all, which is why it is the model that can run for a whole day as well
 * as for a workout.
 *
 * An absent zone among present ones counts as no time spent there - a day with 30 light minutes
 * and nothing else recorded is a load of 30. Every zone absent is not a load of zero, it is no
 * load recorded, and answering null rather than 0 is what lets the daily derive write no row at
 * all instead of a zero nobody measured. A recorded zero survives as a zero, from either case.
 */
export function edwardsLoad(zones: ZoneMinutes): number | null {
  const minutes = [zones.lightMinutes, zones.moderateMinutes, zones.vigorousMinutes, zones.peakMinutes]
  if (minutes.every((value) => value === null)) return null
  let load = 0
  for (const [index, value] of minutes.entries()) {
    if (value === null) continue
    load += EDWARDS_WEIGHTS[index]! * value
  }
  return load
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whole years between a birthday and a local date, both as `YYYY-MM-DD`.
 *
 * Two date strings rather than an instant, deliberately. An age is a question about calendars and
 * not about moments, and the caller always has the local date it means - a session's own
 * `localDate`, or the day being derived. Taking a timestamp here would reintroduce the offset
 * question this function does not need to ask, and would make a birthday land on the wrong day for
 * anyone east of UTC.
 *
 * Comparing the `MM-DD` text is also what makes a 29 February birthday behave: it has not come
 * round on 28 February and has on 1 March, with no leap year special case written anywhere.
 */
export function ageAt(birthDate: string, onLocalDate: string): number | null {
  if (!LOCAL_DATE.test(birthDate) || !LOCAL_DATE.test(onLocalDate)) return null
  const birthYear = Number(birthDate.slice(0, 4))
  const onYear = Number(onLocalDate.slice(0, 4))
  const hadBirthday = onLocalDate.slice(5) >= birthDate.slice(5)
  const age = onYear - birthYear - (hadBirthday ? 0 : 1)
  return age < 0 ? null : age
}
