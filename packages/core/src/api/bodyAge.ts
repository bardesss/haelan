/**
 * Body age: a mortality-equivalent age from wearable data, computed on read and never stored.
 *
 * Every factor is turned into years the same way. A factor's hazard ratio for all-cause mortality,
 * at the person's value and relative to the reference value for their age and sex, is divided by
 * `GOMPERTZ_SLOPE`, the yearly log-increase in adult mortality. That gives the number of calendar
 * years whose added risk is the same size:
 *
 *   bodyAge = calendarAge + Σᵢ clamp( ln HRᵢ(xᵢ) / GOMPERTZ_SLOPE, −capᵢ, +capᵢ )
 *
 * One constant converts every factor, so every row is in years and a reader can add them. A person
 * exactly at every reference scores exactly their calendar age, because each `logHazard` is a
 * difference of the same curve at two points and is zero when the two points coincide.
 *
 * This file holds the arithmetic, the cited constants, and the body age of one 30-day window.
 * Reading the days out of the database is built on top of it elsewhere.
 *
 * **This module feeds a printed number, so it states what it honours** (CONTRIBUTING.md, "A reader
 * that feeds a number says what it honours"):
 *
 * - **Session kinds: none read here.** The strength factor takes a sessions-per-week count from its
 *   caller. That caller must count only exercise sessions whose category is strength, never sleep
 *   or any other session kind, or a night's sleep would make someone younger.
 * - **Override actions: none read here.** Values arrive already derived. Whoever reads them must
 *   take `exclude` and `correct` from the merged daily rows, where both are already applied.
 * - **Thinned: never.** No input to these functions may come from a series fetched with `points`.
 *   A body age that moved when a chart's point budget moved would not be measuring anything.
 *
 * **Nothing here is stored.** Not the factors, not the years, not the body age. The schema keeps a
 * birth date and nothing derived from it, and this module keeps to that.
 */

import { shiftLocalDate } from '../derive/localDay.ts'
import type { DayValue } from './recoveryIndex.ts'

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

export type BodyAgeFactorKey = 'vo2Max' | 'restingHeartRate' | 'hrv' | 'activity' | 'sleepRegularity' | 'strength'

export type Sex = 'male' | 'female'

export interface BodyAgeFactorSpec {
  key: BodyAgeFactorKey
  unit: string
  /** The most years this factor may add or take away on its own. */
  cap: number
  /** Study, table or figure, and population for every figure the factor uses. */
  citation: string
  /** The typical value for this age and sex. A person at it scores zero years on this factor. */
  reference(age: number, sex: Sex): number
  /** ln of the hazard ratio of `value` against `reference`. Zero when the two are equal. */
  logHazard(value: number, reference: number): number
}

/**
 * The yearly log-increase in adult all-cause mortality.
 *
 * Finch, Pike & Witten 1990, Science 249:902-905 (abstract): human mortality rate doubles about
 * every 8 years. In the Gompertz model that is a slope of ln 2 / 8 = 0.087; 0.085 (a doubling time of
 * 8.2 years) is the rounder figure the design uses, and the gap between the two is far inside the
 * uncertainty of any hazard ratio below.
 */
export const GOMPERTZ_SLOPE = 0.085

/**
 * The most years the factors together may add or take away. The factors are correlated (a fit
 * person tends to have a low resting heart rate too), so adding their log hazards as if they were
 * independent over-counts. The total cap is where that is admitted.
 */
// provisional: set by probe/scripts/body-age.mjs (plan Task 5)
export const BODY_AGE_TOTAL_CAP = 10

/** The window is the 30 days ending on the most recent scored day: weeks, not one night. */
export const BODY_AGE_WINDOW_DAYS = 30

/** VO2 max readings are sparse, so the latest one within this many days of the window's end counts. */
export const VO2_LOOKBACK_DAYS = 180

/** A daily factor needs at least this many present days in the window, or it is missing. */
export const MIN_FACTOR_DAYS = 10

/** A point on a piecewise-linear curve. */
type Knot = readonly [x: number, y: number]

/**
 * Linear interpolation through `knots` (sorted by x), held flat beyond the first and last knot.
 *
 * Flat at the ends rather than extrapolated, on purpose: a table that stops at 79 says nothing about
 * 90, and a dose-response that stops at its last band says nothing about twice that dose.
 */
function interpolate(knots: readonly Knot[], x: number): number {
  const first = knots[0]!
  const last = knots[knots.length - 1]!
  if (x <= first[0]) return first[1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < knots.length; i += 1) {
    const [x1, y1] = knots[i]!
    if (x <= x1) {
      const [x0, y0] = knots[i - 1]!
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return last[1]
}

/**
 * VO2 max 50th percentile, ml/kg/min, at each decade's midpoint.
 *
 * Kaminsky et al. 2015, Mayo Clin Proc 90:1515-1523, Table 3 (FRIEND registry, treadmill): 7,783
 * maximal treadmill tests (4,611 men, 3,172 women) aged 20-79 from 8 US laboratories, 2014-2015,
 * with no known coronary or peripheral artery disease, heart failure or COPD, and a peak RER ≥ 1.00.
 * Decades 20-29 to 70-79 are placed at 25 to 75.
 */
const VO2_P50: Readonly<Record<Sex, readonly Knot[]>> = {
  male: [[25, 48.0], [35, 42.4], [45, 37.8], [55, 32.6], [65, 28.2], [75, 24.4]],
  female: [[25, 37.6], [35, 30.2], [45, 26.7], [55, 23.4], [65, 20.0], [75, 18.3]],
}

/**
 * Mean daily resting heart rate, bpm, by age, read off a figure.
 *
 * Quer et al. 2020, PLoS ONE 15:e0227709, Fig 3A: 92,457 US adults wearing a Fitbit wrist tracker at
 * least 20 h/day, 2 days/week, over at least 35 weeks between March 2016 and February 2018 (32.7
 * million daily RHR values; 63% women, mean age 45.8). The paper publishes this curve only as a figure,
 * so the values are read off it at its 4-year points to about ±0.3 bpm. They are means, not medians.
 *
 * Why not Natarajan et al. 2020, as the design first named: that paper (Lancet Digital Health,
 * not npj Digital Medicine) reports HRV and does not report resting heart rate by age and sex.
 * Quer et al. is the same kind of population (Fitbit wearers, daily device RHR) and does.
 */
const RHR_MEAN: Readonly<Record<Sex, readonly Knot[]>> = {
  male: [
    [20, 61.8], [24, 61.4], [28, 62.0], [32, 62.7], [36, 63.3], [40, 64.1], [44, 64.8], [48, 64.7],
    [52, 65.0], [56, 64.1], [60, 64.0], [64, 63.0], [68, 62.2], [72, 61.4], [76, 61.3], [80, 60.6],
    [84, 59.9],
  ],
  female: [
    [20, 65.8], [24, 66.3], [28, 66.8], [32, 66.9], [36, 67.1], [40, 67.4], [44, 67.5], [48, 67.6],
    [52, 67.1], [56, 66.6], [60, 66.4], [64, 65.6], [68, 65.4], [72, 64.7], [76, 63.9], [80, 63.8],
    [84, 63.9],
  ],
}

/**
 * ln HR of leisure-time moderate-to-vigorous activity against none, by minutes a week.
 *
 * Arem et al. 2015, JAMA Intern Med 175:959-967, Results text and Figure 1 (all-cause mortality,
 * fully adjusted): 661,137 adults (median age 62, range 21-98) in 6 US and European cohorts of the
 * NCI Cohort Consortium, 116,686 deaths, median follow-up 14.2 years. HRs against 0 MET h/wk:
 * 0.1-<7.5 → 0.80, 7.5-<15 → 0.69, 15-<22.5 → 0.63, 22.5-<40 → 0.61, 40-<75 → 0.61, 75+ → 0.68.
 *
 * MET hours become minutes by the guideline equivalence the paper itself uses: 7.5 MET h/wk is 150
 * moderate minutes, so one MET hour is 20 minutes. Each band's HR is placed at its midpoint in
 * minutes (75, 225, 375, 625) and the curve is flat from the 3-5× band onward. The 75+ band's 0.68
 * is deliberately not followed upward. The paper reports no harm there, and the design says more
 * activity must never make a person older.
 */
const ACTIVITY_LN_HR: readonly Knot[] = [
  [0, 0],
  [75, Math.log(0.80)],
  [225, Math.log(0.69)],
  [375, Math.log(0.63)],
  [625, Math.log(0.61)],
]

/**
 * ln HR of the sleep onset spread, by its standard deviation in minutes.
 *
 * Windred et al. 2024, Sleep 47:zsad253, Table 2 (all-cause mortality by Sleep Regularity Index
 * quintile, fully adjusted model, n = 46,721): 1.00, 0.80, 0.75, 0.72, 0.70, from the least to the
 * most regular fifth. Population: 60,977 UK Biobank participants aged about 44-79 (mean 62.8) with a
 * week of wrist accelerometry, followed for a mean of 6.3 years.
 *
 * The method that maps SRI to a bedtime spread: the paper's Supplementary Table S2.7 gives, for each
 * SRI quintile, the median within-person SD of sleep onset time over the same week: 1.58, 1.08,
 * 0.85, 0.68 and 0.47 hours. Each quintile's HR is placed at that median (95, 65, 51, 41 and 28
 * minutes) and interpolated between. haelan's bedtime spread is a PROXY for the SRI: the mean of the
 * SDs of bedtime over the window's 7-day blocks, the same one-week span as the paper's onset SD. The
 * SRI also counts wake times, naps and broken nights, which a bedtime SD does not see.
 */
const SLEEP_SPREAD_LN_HR: readonly Knot[] = [
  [28.2, Math.log(0.70)],
  [40.8, Math.log(0.72)],
  [51.0, Math.log(0.75)],
  [64.8, Math.log(0.80)],
  [94.8, Math.log(1.00)],
]

/**
 * The reference spread is the middle SRI fifth's median onset SD, 0.85 h (Windred et al. 2024,
 * Table S2.7). The cohort's median SRI (81.0) falls in that fifth. One value for everyone: the
 * paper adjusts for age and sex and reports no spread by either.
 */
const SLEEP_SPREAD_REFERENCE_MINUTES = 51.0

/**
 * Strength training: any against none.
 *
 * Momma et al. 2022, BJSM 56:755-763, Table 1 and Figure 2 (two-group meta-analysis, all-cause
 * mortality): RR 0.85 (95% CI 0.79-0.93) for any muscle-strengthening activity against none, 7
 * prospective cohorts, 263,058 adults without severe health conditions, 42,133 deaths. The paper's
 * non-linear dose-response (Figure 4) bottoms out at RR 0.83 at 40 min/week and is J-shaped after.
 *
 * The paper counts minutes; haelan counts sessions. One session a week is taken as the "any" exposure
 * and as the peak: one ordinary session is already about the 40 minutes where the paper's benefit
 * peaks, so more sessions earn nothing more. Fewer than one a week (one every fortnight, say) is
 * scaled linearly. The two-group 0.85 is used rather than the 0.83 minimum because it needs no
 * guess about how long a session lasts.
 */
const STRENGTH_PEAK_SESSIONS_PER_WEEK = 1
const STRENGTH_LN_HR_AT_PEAK = Math.log(0.85)

/**
 * The factors, in the order of `BodyAgeFactorKey`.
 *
 * HRV is not here. The design asked for a per-unit all-cause figure on ln(RMSSD), starting from
 * Hillebrand et al. 2013 (Europace 15:742-749). That meta-analysis does not give one. It pools 8
 * studies (21,988 people) of a FIRST CARDIOVASCULAR EVENT, not all-cause death, and only for SDNN,
 * LF and HF. RMSSD is not among its measures (abstract: lowest vs highest SDNN RR 1.35, about 1%
 * lower CVD risk per 1% higher SDNN). The reference side fails too: Natarajan et al. 2020 (Lancet
 * Digital Health 2:e650) puts its RMSSD benchmark tables by age and sex in an appendix that could
 * not be retrieved and checked. Shipping either number would mean inventing it, so the factor
 * stays out until a citable all-cause figure for RMSSD exists. If it ever comes back, its cap was to
 * be 1.5, the smallest of all, and the test that guards this still runs whenever it is present.
 */
export const BODY_AGE_FACTORS: readonly BodyAgeFactorSpec[] = [
  {
    key: 'vo2Max',
    unit: 'ml/kg/min',
    // provisional: set by probe/scripts/body-age.mjs (plan Task 5)
    cap: 6,
    citation:
      'Hazard: Kodama et al. 2009, JAMA 301:2024-2035, abstract (pooled all-cause RR 0.87, 95% CI 0.84-0.90, '
      + 'per 1-MET higher maximal aerobic capacity; 33 cohorts of healthy men and women, 102,980 participants, '
      + '6,910 deaths); 1 MET = 3.5 ml/kg/min. Reference: Kaminsky et al. 2015, Mayo Clin Proc 90:1515-1523, '
      + 'Table 3, 50th percentile by sex and decade (FRIEND registry, 7,783 maximal treadmill tests, US adults '
      + '20-79 without known cardiovascular disease or COPD), linear between decade midpoints, flat beyond.',
    reference: (age, sex) => interpolate(VO2_P50[sex], age),
    logHazard: (value, reference) => (Math.log(0.87) * (value - reference)) / 3.5,
  },
  {
    key: 'restingHeartRate',
    unit: 'bpm',
    // provisional: set by probe/scripts/body-age.mjs (plan Task 5)
    cap: 3,
    citation:
      'Hazard: Zhang, Shen & Qi 2016, CMAJ 188:E53-E63, abstract and dose-response analysis (all-cause RR 1.09, '
      + '95% CI 1.07-1.12, per 10 beats/min; 46 cohorts of the general population, 1,246,203 participants, '
      + '78,349 deaths; linear relation). Reference: Quer et al. 2020, PLoS ONE 15:e0227709, Fig 3A, mean daily '
      + 'resting heart rate by age and sex (92,457 US Fitbit wearers, 32.7 million daily values), read off the '
      + 'figure at 4-year points, linear between, flat beyond 20 and 84.',
    reference: (age, sex) => interpolate(RHR_MEAN[sex], age),
    logHazard: (value, reference) => (Math.log(1.09) * (value - reference)) / 10,
  },
  {
    key: 'activity',
    // Minutes a week in which vigorous minutes already count double: the caller builds each day's
    // value as moderate + 2 × vigorous, as the paper's MET hours do.
    unit: 'min/week',
    // provisional: set by probe/scripts/body-age.mjs (plan Task 5)
    cap: 2,
    citation:
      'Arem et al. 2015, JAMA Intern Med 175:959-967, Results and Figure 1, all-cause HR by leisure-time '
      + 'MVPA band against none (0.80, 0.69, 0.63, 0.61, 0.61 for 0.1-<7.5 to 40-<75 MET h/wk; 661,137 adults '
      + 'aged 21-98 in 6 US/European NCI Cohort Consortium cohorts, 116,686 deaths). 1 MET h = 20 moderate '
      + 'minutes (7.5 MET h = 150 min), bands at their midpoints, flat from the 3-5x band on. Reference: '
      + '150 min/week, the guideline minimum the paper is built around.',
    reference: () => 150,
    logHazard: (value, reference) => interpolate(ACTIVITY_LN_HR, value) - interpolate(ACTIVITY_LN_HR, reference),
  },
  {
    key: 'sleepRegularity',
    unit: 'min',
    // provisional: set by probe/scripts/body-age.mjs (plan Task 5)
    cap: 2,
    citation:
      'Windred et al. 2024, Sleep 47:zsad253, Table 2 (all-cause HR by Sleep Regularity Index quintile, fully '
      + 'adjusted: 1.00, 0.80, 0.75, 0.72, 0.70; 60,977 UK Biobank adults aged ~44-79 with wrist accelerometry). '
      + 'Mapped to a bedtime spread through Supplementary Table S2.7, the median within-person SD of sleep '
      + 'onset per SRI quintile (1.58, 1.08, 0.85, 0.68, 0.47 h): each HR sits at its quintile\'s median SD. '
      + 'Reference: the middle quintile\'s 0.85 h (51 min). Bedtime SD is a proxy for the SRI.',
    reference: () => SLEEP_SPREAD_REFERENCE_MINUTES,
    logHazard: (value, reference) =>
      interpolate(SLEEP_SPREAD_LN_HR, value) - interpolate(SLEEP_SPREAD_LN_HR, reference),
  },
  {
    key: 'strength',
    unit: 'sessions/week',
    // provisional: set by probe/scripts/body-age.mjs (plan Task 5)
    cap: 2,
    citation:
      'Momma et al. 2022, BJSM 56:755-763, Table 1 and Figure 2 (all-cause RR 0.85, 95% CI 0.79-0.93, any '
      + 'muscle-strengthening activity against none; 7 cohorts, 263,058 adults without severe health '
      + 'conditions). Benefit peaks at 40 min/week (Figure 4, RR 0.83), taken as one session a week; value '
      + 'clamped there, linear below. Reference: 0 sessions.',
    reference: () => 0,
    logHazard: (value, reference) => {
      const dose = (sessions: number): number =>
        Math.min(Math.max(sessions, 0), STRENGTH_PEAK_SESSIONS_PER_WEEK) / STRENGTH_PEAK_SESSIONS_PER_WEEK
      return STRENGTH_LN_HR_AT_PEAK * (dose(value) - dose(reference))
    },
  },
]

/**
 * A log hazard in years, held inside ±`cap`. `capped` says whether the cap bound, so the page can
 * say a factor has hit its limit rather than show a number that stopped moving for no visible reason.
 */
export function yearsOf(logHazard: number, cap: number): { years: number, capped: boolean } {
  const years = logHazard / GOMPERTZ_SLOPE
  if (years > cap) return { years: cap, capped: true }
  if (years < -cap) return { years: -cap, capped: true }
  // `+ 0` turns a −0 (a negative slope times a zero difference) into 0, so "at the reference" is
  // one value rather than two that print the same and compare differently.
  return { years: years + 0, capped: false }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** A real calendar date as UTC milliseconds, or null for text like 1988-13-45. */
function parseLocalDate(localDate: string): number | null {
  if (!LOCAL_DATE.test(localDate)) return null
  const year = Number(localDate.slice(0, 4))
  const month = Number(localDate.slice(5, 7))
  const day = Number(localDate.slice(8, 10))
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  return ms
}

/** The birthday in `year`. A 29 February birthday falls on 1 March in a common year, as in `ageAt`. */
function birthdayIn(birthDate: string, year: number): number {
  const month = Number(birthDate.slice(5, 7))
  const day = Number(birthDate.slice(8, 10))
  if (month === 2 && day === 29 && !isLeapYear(year)) return Date.UTC(year, 2, 1)
  return Date.UTC(year, month - 1, day)
}

/** Body age is an adult statistic: every reference table above starts at 20, and the hazards are adult. */
const MIN_AGE_YEARS = 18

/**
 * Age in fractional years between a birth date and a local date, both `YYYY-MM-DD`.
 *
 * Whole years by comparing `MM-DD` text, as `ageAt` in cardioLoad.ts does, so a 29 February birthday
 * has not come round on 28 February and has on 1 March. The fraction is the share of the way from
 * the last birthday to the next one, so a year is a year whether it has 365 days or 366.
 *
 * Null for a date that does not parse or does not exist, a birth date after `onLocalDate`, and an
 * age under 18.
 */
export function ageYearsAt(birthDate: string, onLocalDate: string): number | null {
  const birthMs = parseLocalDate(birthDate)
  const onMs = parseLocalDate(onLocalDate)
  if (birthMs === null || onMs === null || birthMs > onMs) return null
  const birthYear = Number(birthDate.slice(0, 4))
  const onYear = Number(onLocalDate.slice(0, 4))
  const hadBirthday = onLocalDate.slice(5) >= birthDate.slice(5)
  const whole = onYear - birthYear - (hadBirthday ? 0 : 1)
  const last = birthdayIn(birthDate, birthYear + whole)
  const next = birthdayIn(birthDate, birthYear + whole + 1)
  // Whole days apart, rounded: UTC midnights are exact, but a rounding keeps the fraction honest if
  // that ever stops being true.
  const age = whole + Math.round((onMs - last) / DAY_MS) / Math.round((next - last) / DAY_MS)
  return age < MIN_AGE_YEARS ? null : age
}

/**
 * The age at which `vo2Max` is the 50th percentile for this sex: the VO2 factor's `reference`,
 * inverted. It is the comparison line on the VO2 max row ("fitness age 35") and does not feed
 * the body age.
 *
 * Only within the table's own span, 25 to 75 (its decade midpoints). A reading above the 25-year
 * median or below the 75-year one returns null. A fitness age of 25 for a reading far above the
 * youngest decade's median would claim a precision the table does not have.
 */
export function fitnessAgeOf(vo2Max: number, sex: Sex): number | null {
  const knots = VO2_P50[sex]
  // The medians fall with every decade, so walk the segments and invert the one that holds vo2Max.
  for (let i = 1; i < knots.length; i += 1) {
    const [age0, v0] = knots[i - 1]!
    const [age1, v1] = knots[i]!
    if (vo2Max <= v0 && vo2Max >= v1) return age0 + ((age1 - age0) * (v0 - vo2Max)) / (v0 - v1)
  }
  return null
}

export interface BodyAgeInput {
  birthDate: string | null
  sex: Sex | null
  vo2Max: DayValue[]
  restingHeartRate: DayValue[]
  /** Raw ms. Not a factor, but its days tell the caller which days were scored. */
  hrv: DayValue[]
  /** Minutes per day, vigorous minutes already counted double. */
  activityMinutes: DayValue[]
  /** Minutes from midnight, signed so that either side of midnight stays close. */
  bedtimeMinutes: DayValue[]
  strengthSessionDates: string[]
}

export type BodyAgeMissing = 'birthDate' | 'sex' | 'vo2Max'

export interface BodyAgeFactor {
  key: BodyAgeFactorKey
  value: number | null
  reference: number | null
  years: number
  capped: boolean
  /** Days with a reading in the window. */
  days: number
  missing: 'tooFewDays' | 'noReading' | null
}

export interface BodyAgeUnavailable {
  enough: false
  endDate: string
  missing: BodyAgeMissing[]
}

export interface BodyAgeAvailable {
  enough: true
  endDate: string
  window: { from: string, to: string }
  calendarAge: number
  bodyAge: number
  gap: number
  totalCapped: boolean
  factors: BodyAgeFactor[]
  carriedBy: BodyAgeFactorKey | null
  mostRoom: { key: BodyAgeFactorKey, years: number } | null
  fitnessAge: number | null
  vo2MaxDate: string | null
}

export type BodyAge = BodyAgeUnavailable | BodyAgeAvailable

const CARRIED_TIE_EPSILON = 1e-9

function mean(values: readonly number[]): number {
  return values.reduce((t, v) => t + v, 0) / values.length
}

/** Sample standard deviation (n - 1). */
function sampleStandardDeviation(values: readonly number[]): number {
  const m = mean(values)
  return Math.sqrt(values.reduce((t, v) => t + (v - m) ** 2, 0) / (values.length - 1))
}

const SLEEP_BLOCK_DAYS = 7
const SLEEP_BLOCKS = 4
const MIN_NIGHTS_PER_BLOCK = 4
const MIN_SLEEP_BLOCKS = 2

/**
 * The mean of the sample SDs of bedtime over consecutive 7-day blocks ending on `endDate`, or null
 * when fewer than two blocks have at least four nights. The week is Windred's own window for the
 * onset SD, and a bedtime that holds steady within each week but drifts between weeks reads as regular.
 * The two oldest days of the 30 fall in no block.
 */
function weeklySleepSpread(rows: readonly DayValue[], endDate: string): number | null {
  const spreads: number[] = []
  for (let k = 0; k < SLEEP_BLOCKS; k += 1) {
    const to = shiftLocalDate(endDate, -SLEEP_BLOCK_DAYS * k)
    const values = inWindow(rows, shiftLocalDate(to, -(SLEEP_BLOCK_DAYS - 1)), to)
    if (values.length >= MIN_NIGHTS_PER_BLOCK) spreads.push(sampleStandardDeviation(values))
  }
  return spreads.length >= MIN_SLEEP_BLOCKS ? mean(spreads) : null
}

/** One value per day inside the window; a repeated date keeps its last row. */
function inWindow(rows: readonly DayValue[], from: string, to: string): number[] {
  const byDate = new Map<string, number>()
  for (const row of rows) if (row.localDate >= from && row.localDate <= to) byDate.set(row.localDate, row.value)
  return [...byDate.values()]
}

/**
 * The factor whose years lean furthest the way the gap points, named only when it holds at least
 * half of all the years in that direction. A tie or no lean names none, as `carriedByOf` does for
 * the recovery index.
 */
function carriedByOf(factors: readonly BodyAgeFactor[], gap: number): BodyAgeFactorKey | null {
  const sign = gap > CARRIED_TIE_EPSILON ? 1 : gap < -CARRIED_TIE_EPSILON ? -1 : 0
  if (sign === 0) return null
  const pushes = factors.map((f) => ({ key: f.key, push: f.years * sign })).filter((p) => p.push > CARRIED_TIE_EPSILON)
  if (pushes.length === 0) return null
  pushes.sort((a, b) => b.push - a.push)
  const total = pushes.reduce((t, p) => t + p.push, 0)
  const [first, second] = pushes
  if (second !== undefined && first!.push - second.push < CARRIED_TIE_EPSILON) return null
  return first!.push >= total / 2 - CARRIED_TIE_EPSILON ? first!.key : null
}

/**
 * The body age for the 30 days ending `endDate`. Unavailable without a usable birth date, a sex and
 * a VO2 max reading; every other factor that lacks days is marked missing and adds zero years.
 */
export function bodyAgeAt(input: BodyAgeInput, endDate: string): BodyAge {
  const from = shiftLocalDate(endDate, -(BODY_AGE_WINDOW_DAYS - 1))
  const calendarAge = input.birthDate === null ? null : ageYearsAt(input.birthDate, endDate)
  const vo2Floor = shiftLocalDate(endDate, -VO2_LOOKBACK_DAYS)
  let vo2: DayValue | null = null
  for (const row of input.vo2Max) {
    if (row.localDate > endDate || row.localDate < vo2Floor) continue
    if (vo2 === null || row.localDate > vo2.localDate) vo2 = row
  }

  const { sex } = input
  if (calendarAge === null || sex === null || vo2 === null) {
    const missing: BodyAgeMissing[] = []
    if (calendarAge === null) missing.push('birthDate')
    if (sex === null) missing.push('sex')
    if (vo2 === null) missing.push('vo2Max')
    return { enough: false, endDate, missing }
  }

  const daily = (rows: readonly DayValue[], summarise: (values: number[]) => number) => {
    const values = inWindow(rows, from, endDate)
    return { days: values.length, value: values.length >= MIN_FACTOR_DAYS ? summarise(values) : null }
  }
  const strengthDays = new Set(input.strengthSessionDates.filter((d) => d >= from && d <= endDate))
  const strengthSessions = input.strengthSessionDates.filter((d) => d >= from && d <= endDate).length

  const readings: Record<Exclude<BodyAgeFactorKey, 'hrv'>, { value: number | null, days: number }> = {
    vo2Max: { value: vo2.value, days: 1 },
    restingHeartRate: daily(input.restingHeartRate, mean),
    activity: daily(input.activityMinutes, (v) => mean(v) * 7),
    sleepRegularity: {
      value: weeklySleepSpread(input.bedtimeMinutes, endDate),
      days: inWindow(input.bedtimeMinutes, from, endDate).length,
    },
    strength: { value: (strengthSessions * 7) / BODY_AGE_WINDOW_DAYS, days: strengthDays.size },
  }

  const factors: BodyAgeFactor[] = BODY_AGE_FACTORS.map((spec) => {
    const { value, days } = readings[spec.key as keyof typeof readings]
    if (value === null) {
      return {
        key: spec.key, value: null, reference: null, years: 0, capped: false, days,
        missing: days === 0 ? 'noReading' : 'tooFewDays',
      }
    }
    const reference = spec.reference(calendarAge, sex)
    const { years, capped } = yearsOf(spec.logHazard(value, reference), spec.cap)
    return { key: spec.key, value, reference, years, capped, days, missing: null }
  })

  const sum = factors.reduce((t, f) => t + f.years, 0)
  const totalCapped = Math.abs(sum) > BODY_AGE_TOTAL_CAP
  const gap = Math.max(-BODY_AGE_TOTAL_CAP, Math.min(BODY_AGE_TOTAL_CAP, sum)) + 0
  const positive = factors.filter((f) => f.years > 0).sort((a, b) => b.years - a.years)

  return {
    enough: true,
    endDate,
    window: { from, to: endDate },
    calendarAge,
    bodyAge: calendarAge + gap,
    gap,
    totalCapped,
    factors,
    carriedBy: carriedByOf(factors, gap),
    mostRoom: positive[0] === undefined ? null : { key: positive[0].key, years: positive[0].years },
    fitnessAge: fitnessAgeOf(vo2.value, sex),
    vo2MaxDate: vo2.localDate,
  }
}

/** The latest date on or before `onOrBefore` that has a resting heart rate or HRV row, else null. */
export function lastScoredDay(input: BodyAgeInput, onOrBefore: string): string | null {
  let latest: string | null = null
  for (const rows of [input.restingHeartRate, input.hrv]) {
    for (const row of rows) {
      if (row.localDate <= onOrBefore && (latest === null || row.localDate > latest)) latest = row.localDate
    }
  }
  return latest
}

export interface BodyAgeMonth {
  /** `YYYY-MM`. */
  month: string
  /** The month's last scored day on or before today: the end of the window this entry reads. */
  endDate: string
  bodyAge: number
  calendarAge: number
  gap: number
}

export interface BodyAgeHistory {
  /** The body age on the last scored day, not on today: a sync that lags leaves today empty. */
  current: BodyAge | null
  /** The window ending 30 days before `current`'s, when both are available. */
  previous: BodyAgeAvailable | null
  /** One entry per calendar month that has a scored day and a body age, oldest first. */
  months: BodyAgeMonth[]
  /** Years of body age lived per calendar year over the last twelve months. 1 is keeping pace. */
  pace: number | null
  /** The month with the largest gap below calendar age. */
  youngest: BodyAgeMonth | null
}

const DAYS_PER_YEAR = 365.25

function daysBetween(from: string, to: string): number {
  return (parseLocalDate(to)! - parseLocalDate(from)!) / DAY_MS
}

/**
 * The body age now, 30 days earlier, and at the end of every month with data.
 *
 * A month with scored days but a withheld body age (the VO2 reading too old, say) is absent: the
 * hole in the series is the missing month, and nothing is filled in. The pace compares the current
 * month's gap with the entry 12 calendar months before, and is null when that entry is absent.
 * Months tied on the largest gap name the earliest.
 */
export function bodyAgeHistory(input: BodyAgeInput, today: string): BodyAgeHistory {
  const endDate = lastScoredDay(input, today)
  const current = endDate === null ? null : bodyAgeAt(input, endDate)

  let previous: BodyAgeAvailable | null = null
  if (current?.enough) {
    const earlier = lastScoredDay(input, shiftLocalDate(current.endDate, -BODY_AGE_WINDOW_DAYS))
    const body = earlier === null ? null : bodyAgeAt(input, earlier)
    if (body?.enough) previous = body
  }

  const scoredMonths = new Set<string>()
  for (const rows of [input.restingHeartRate, input.hrv]) {
    for (const row of rows) if (row.localDate <= today) scoredMonths.add(row.localDate.slice(0, 7))
  }
  const months: BodyAgeMonth[] = []
  for (const month of [...scoredMonths].sort()) {
    // Dates compare as text: no date in a month is later than its own "31st", and today caps the
    // current month so a row after today cannot become its anchor.
    const anchor = lastScoredDay(input, `${month}-31` < today ? `${month}-31` : today)
    if (anchor === null) continue
    const body = bodyAgeAt(input, anchor)
    if (body.enough) {
      months.push({ month, endDate: anchor, bodyAge: body.bodyAge, calendarAge: body.calendarAge, gap: body.gap })
    }
  }

  let youngest: BodyAgeMonth | null = null
  for (const m of months) if (youngest === null || m.gap < youngest.gap) youngest = m

  let pace: number | null = null
  const now = months[months.length - 1]
  if (current?.enough && now !== undefined && now.endDate === current.endDate) {
    const thenMonth = `${Number(now.month.slice(0, 4)) - 1}${now.month.slice(4)}`
    const then = months.find((m) => m.month === thenMonth)
    if (then !== undefined) {
      pace = 1 + (now.gap - then.gap) / (daysBetween(then.endDate, now.endDate) / DAYS_PER_YEAR)
    }
  }

  return { current, previous, months, pace, youngest }
}
