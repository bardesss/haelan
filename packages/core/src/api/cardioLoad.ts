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
 *
 * The weight sits beside its own minutes in one literal - Edwards' own 1, 2, 3, 4 by zone rank,
 * unchanged - rather than in a same-length array looked up by index, so there is no index lookup
 * whose bounds have to be trusted rather than checked.
 */
/**
 * The daily row `deriveCardioLoadDay` writes, named here beside the calculation rather than in the
 * derive that stores it: a reader in `apps/web` may import from `api/` and not from `derive/`, and
 * a second copy of this string in the web is exactly the drift that would let a card and a derive
 * disagree about which metric they mean.
 */
export const CARDIO_LOAD_METRIC = 'cardio_load_edwards'

export function edwardsLoad(zones: ZoneMinutes): number | null {
  const weighted = [
    { weight: 1, minutes: zones.lightMinutes },
    { weight: 2, minutes: zones.moderateMinutes },
    { weight: 3, minutes: zones.vigorousMinutes },
    { weight: 4, minutes: zones.peakMinutes },
  ]
  if (weighted.every(({ minutes }) => minutes === null)) return null
  let load = 0
  for (const { weight, minutes } of weighted) {
    if (minutes === null) continue
    load += weight * minutes
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

/** One minute of heart rate. `heart_rate` is the one metric stored downsampled to the minute
 *  (api/catalogue.ts, `downsampleToMinute`), so every point stands for exactly one minute and dt
 *  below is 1 rather than a duration each point has to carry. */
export interface MinuteBpm {
  utcMs: number
  bpm: number
}

export interface BanisterParams {
  restingBpm: number
  maxBpm: number
  k: number
}

/** Banister's own coefficients: the exponential rises faster for men than for women. */
export function coefficientFor(sex: 'male' | 'female'): number {
  return sex === 'male' ? 1.92 : 1.67
}

/**
 * Banister TRIMP over a heart rate trace.
 *
 *   dHR   = (HR - HRrest) / (HRmax - HRrest)
 *   TRIMP = sum of  dt * dHR * e^(k * dHR)
 *
 * Runs per workout only, never for a whole day. Google counts cardio load from the light zone
 * upward, and the API stores zone ceilings but never zone floors, so the light zone's floor is the
 * one boundary that cannot be read. Inside a workout the exponential makes that nearly free - a
 * near-resting minute contributes almost nothing - but over 600 waking minutes just above resting
 * it sums to roughly 70 TRIMP of doing nothing, which would make a sedentary day read as a
 * training day. A workout has a floor that needs no inventing: its own span.
 *
 * Null for an empty trace rather than 0: no minutes observed is not a workout of no effort.
 *
 * Null when the maximum is at or below resting. That is a profile that is wrong rather than a
 * person who is unusual, and the alternative is a divide by zero or a negative denominator that
 * turns e^(k * dHR) into Infinity - a number that would then be printed as a cardio load.
 */
export function banisterLoad(
  minutes: readonly MinuteBpm[],
  params: BanisterParams,
): number | null {
  if (minutes.length === 0) return null
  const reserve = params.maxBpm - params.restingBpm
  if (!(reserve > 0)) return null

  let load = 0
  for (const point of minutes) {
    // Clamped rather than dropped: a minute below resting was still observed, and it contributes
    // nothing rather than subtracting from the effort of the minutes around it.
    const delta = Math.max(0, (point.bpm - params.restingBpm) / reserve)
    load += delta * Math.exp(params.k * delta)
  }
  return load
}

/** Where a Banister number came from, carried beside it everywhere it is printed. This codebase
 *  does not show a number without saying what produced it, and a cardio load is the most easily
 *  mistaken number on a workout page, because Google shows one too. */
export interface BanisterBasis {
  restingBpm: number
  maxBpm: number
  /** `providerZoneCeiling` is heart_rate_zone_peak_max_bpm for the day, which is the ceiling
   *  Google computed that day's zones against. `ageFormula` is 220 - age, used only when the day
   *  has no such row. */
  maxBpmSource: 'providerZoneCeiling' | 'ageFormula'
  k: number
  /** How many minutes of heart rate the sum was taken over. */
  minutes: number
}

export interface CardioLoad {
  edwards: number | null
  banister: number | null
  banisterBasis: BanisterBasis | null
}
