import { shiftLocalDate } from '../derive/localDay.ts'
import { BASELINE_WINDOW_DAYS, baselineOf, baselineWindow, zScoreOf } from '../query/baseline.ts'

/** One observed day of one metric. A day nobody wore a device is ABSENT, never present as zero. */
export interface DayValue {
  localDate: string
  value: number
}

export type RecoveryInputKey = 'hrv' | 'restingHeartRate' | 'sleep' | 'respiratoryRate'

/** The sleep input is a week, matching the app's own "afgelopen week aan slaap". */
export const SLEEP_WEEK_DAYS = 7

/**
 * The first local date a caller must fetch in order to score `endDate`.
 *
 * Scoring day D reads a baseline over [D-60, D-1]. Each day in that baseline carries a sleep week
 * of its own, so the oldest baseline day needs the six days before it: D-60-6 = D-66.
 *
 * Exported for the same reason `chronicWindowStart` is: a caller computing its own start can
 * quietly ask for 65 days or 67 and still get an answer, and the baseline would then be measuring
 * a window nobody chose.
 */
export function recoveryWindowStart(endDate: string): string {
  return shiftLocalDate(endDate, -(BASELINE_WINDOW_DAYS + SLEEP_WEEK_DAYS - 1))
}

/** Which way is better. `down` flips the sign so positive always means better recovered. */
export type Direction = 'up' | 'down'

export interface DateRange {
  from: string
  to: string
}

/**
 * Sign-corrected z-scores for every date in `range`, against a rolling 60-day baseline ending the
 * day before each one.
 *
 * Null where the day has no value, where its baseline is thin, or where the spread is zero — the
 * three cases `baselineOf` and `zScoreOf` already distinguish, kept distinct here rather than
 * collapsed into a number that would read as "average".
 *
 * Dates are compared as text. `YYYY-MM-DD` sorts lexicographically, so a window test needs no
 * parsing and no timezone question, the same convention `trainingLoad` uses.
 */
export function zSeries(
  days: readonly DayValue[],
  range: DateRange,
  direction: Direction,
): Map<string, number | null> {
  const byDate = new Map(days.map((day) => [day.localDate, day.value]))
  const sorted = [...days].sort((a, b) => a.localDate < b.localDate ? -1 : 1)
  const out = new Map<string, number | null>()

  for (let date = range.from; date <= range.to; date = shiftLocalDate(date, 1)) {
    const value = byDate.get(date)
    if (value === undefined) {
      out.set(date, null)
      continue
    }
    const { from: windowFrom, to: windowTo } = baselineWindow(date)
    const history = sorted
      .filter((day) => day.localDate >= windowFrom && day.localDate <= windowTo)
      .map((day) => day.value)
    const baseline = baselineOf(history)
    if (baseline === null || baseline.thin) {
      out.set(date, null)
      continue
    }
    const z = zScoreOf(value, baseline)
    out.set(date, z === null ? null : (direction === 'down' ? -z : z))
  }
  return out
}

/**
 * How many of the week's seven nights must be observed before the week is a week.
 *
 * A proposal rather than a derived truth, in the manner of `MIN_WORN_ACUTE`: four of seven is the
 * same fraction that reader settled on, and a mean over two nights called "last week's sleep"
 * would be the most misleading thing this input could say. Argue with it here.
 */
export const MIN_SLEEP_NIGHTS = 4

function meanOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function spreadOf(values: readonly number[]): number {
  if (values.length < 2) return 0
  const centre = meanOf(values)
  return Math.sqrt(values.reduce((t, v) => t + (v - centre) ** 2, 0) / (values.length - 1))
}

/**
 * The week's sleep, as two series over `range`: duration (the mean) and consistency (the spread of
 * bedtimes). Both are per-date statistics over the seven days ENDING on that date, which is what
 * makes them comparable against a baseline built from the same statistic on earlier dates.
 *
 * A date with fewer than `MIN_SLEEP_NIGHTS` observed nights is omitted entirely rather than
 * emitted from what few nights there are. Absence is how the caller learns to redistribute the
 * weight; a thin mean would instead be scored as though it were a week.
 */
export function sleepWeekSeries(
  asleepMinutes: readonly DayValue[],
  bedtimeMinutes: readonly DayValue[],
  range: DateRange,
): { duration: DayValue[], consistency: DayValue[] } {
  const asleepBy = new Map(asleepMinutes.map((day) => [day.localDate, day.value]))
  const bedtimeBy = new Map(bedtimeMinutes.map((day) => [day.localDate, day.value]))
  const duration: DayValue[] = []
  const consistency: DayValue[] = []

  for (let date = range.from; date <= range.to; date = shiftLocalDate(date, 1)) {
    const nightsAsleep: number[] = []
    const nightsBedtime: number[] = []
    for (let back = SLEEP_WEEK_DAYS - 1; back >= 0; back -= 1) {
      const night = shiftLocalDate(date, -back)
      const asleep = asleepBy.get(night)
      if (asleep !== undefined) nightsAsleep.push(asleep)
      const bedtime = bedtimeBy.get(night)
      if (bedtime !== undefined) nightsBedtime.push(bedtime)
    }
    if (nightsAsleep.length >= MIN_SLEEP_NIGHTS) {
      duration.push({ localDate: date, value: meanOf(nightsAsleep) })
    }
    if (nightsBedtime.length >= MIN_SLEEP_NIGHTS) {
      consistency.push({ localDate: date, value: spreadOf(nightsBedtime) })
    }
  }
  return { duration, consistency }
}

/**
 * How much each input moves the index.
 *
 * Proposals carrying their reasoning, in the manner of `MIN_WORN_ACUTE`, NOT derived truths. HRV
 * and resting heart rate are the autonomic core and take the larger share; the week's sleep
 * modifies; respiratory rate takes the smallest share because it deviates rarely and is, of the
 * four, the one this design has the least evidence behind. Google does not publish its own
 * weighting, so there is nothing to copy and something had to be chosen.
 *
 * **This object is the calibration target.** Fitting against harvested app scores later must be a
 * change to these four numbers and nothing else.
 */
export const RECOVERY_WEIGHTS: Readonly<Record<RecoveryInputKey, number>> = {
  hrv: 0.35,
  restingHeartRate: 0.30,
  sleep: 0.25,
  respiratoryRate: 0.10,
}

/**
 * The `k` in `100 / (1 + e^(-k·z))`, where z is the weighted composite.
 *
 * Measured on 2026-09-19 by `scripts/probe-recovery-scale.mjs` against this household's own
 * archive (see the spec, "The scale is measured, not chosen"): `k` was set so the more extreme of
 * the 5th/95th percentile composites lands at a score of 10 or 90, with the archive's other tail
 * landing somewhat less extreme than its counterpart - this composite's own asymmetry, not a flaw
 * in the scale. A constant picked to read well in a unit test can put every real day between 47 and
 * 54 and no test would notice.
 *
 * **Placeholder, not settled.** 1.69 is this household's own measurement, kept for now rather than
 * chosen for behaviour. It is expected to be refit once there are harvested Google Health scores to
 * calibrate against - read it as provisional, not as a constant anyone has signed off on.
 */
export const RECOVERY_SCALE = 1.69

/** The two inputs without which this is a different statistic wearing the same name. */
export const REQUIRED_INPUTS: readonly RecoveryInputKey[] = ['hrv', 'restingHeartRate']

export interface RecoveryInput {
  key: RecoveryInputKey
  /** Sign-corrected: positive always means better recovered. */
  z: number
  /** After any redistribution, so the weights present always sum to 1. */
  weight: number
  /**
   * This input's share of the distance from 50, bounded so `|points| <= |score - 50|` for every
   * input regardless of how the others move. Sums to `score - 50` exactly when every present
   * input pushes the same way; sums to something smaller in magnitude when inputs disagree,
   * which is the honest statement that they partly cancelled.
   */
  points: number
}

export interface RecoveryIndexUnavailable {
  enough: false
  /** Which required inputs were absent or too thin to judge. Never empty. */
  missing: readonly RecoveryInputKey[]
}

export interface RecoveryIndexAvailable {
  enough: true
  localDate: string
  /** 0-100, integer. */
  score: number
  /** The weighted composite behind it, kept so a probe can study the distribution. */
  composite: number
  inputs: readonly RecoveryInput[]
  /** Optional inputs that were absent; their weight was redistributed across the rest. */
  degraded: readonly RecoveryInputKey[]
}

/**
 * A union rather than `RecoveryIndex | null`, following `TrainingLoad`: a caller cannot read a
 * score without having passed the gate, and the unavailable case still carries something worth
 * rendering.
 */
export type RecoveryIndex = RecoveryIndexUnavailable | RecoveryIndexAvailable

/**
 * The five raw series, each already filtered to merged daily rows over `recoveryWindowStart(on)`
 * through `on`. A day nobody wore a device is ABSENT rather than present as zero.
 */
export interface RecoveryIndexInput {
  hrv: readonly DayValue[]
  restingHeartRate: readonly DayValue[]
  respiratoryRate: readonly DayValue[]
  asleepMinutes: readonly DayValue[]
  bedtimeMinutes: readonly DayValue[]
}

/**
 * The recovery index for every date in `range`.
 *
 * **This reader feeds a printed number, so it states what it honours** (CONTRIBUTING.md, "A reader
 * that feeds a number says what it honours"):
 *
 * - **Session kinds: none.** It reads merged daily rows and never touches sessions, so the sleep
 *   against exercise confusion that once answered 65.10 TRIMP cannot arise here.
 * - **Override actions: both, already applied upstream.** Exclusions and corrections are resolved
 *   at derivation; `daily` excludes an overridden value by construction.
 * - **Thinned: no.** The caller must not pass `points` to `/series`. A point budget is an argument
 *   about display, and an index that moved when a chart's budget moved would not be measuring
 *   anything. Anything added here that starts passing `points` breaks the number.
 *
 * **Nothing re-scales per person or per period.** The composite is plain `Σ wᵢzᵢ`, so zero always
 * means "at your baseline" rather than relative to something that moves, and `RECOVERY_SCALE` does
 * the range work once for everyone. Dividing by the composite's own spread was considered and
 * dropped: it needs a 126-day window rather than this one's 66, it drifts as a person's volatility
 * changes, and it makes two people's numbers incomparable.
 */
export function recoveryIndexSeries(
  input: RecoveryIndexInput,
  range: DateRange,
): Map<string, RecoveryIndex> {
  // A z on day D reads a baseline over [D-60, D-1], so the sleep week statistic has to exist for
  // those earlier days too - and each of THOSE needs the six days before it, which is exactly what
  // `recoveryWindowStart` reaches back for.
  const sleep = sleepWeekSeries(input.asleepMinutes, input.bedtimeMinutes, {
    from: shiftLocalDate(range.from, -BASELINE_WINDOW_DAYS),
    to: range.to,
  })

  const zRange = range

  const z = {
    hrv: zSeries(input.hrv, zRange, 'up'),
    restingHeartRate: zSeries(input.restingHeartRate, zRange, 'down'),
    respiratoryRate: zSeries(input.respiratoryRate, zRange, 'down'),
    sleepDuration: zSeries(sleep.duration, zRange, 'up'),
    sleepConsistency: zSeries(sleep.consistency, zRange, 'down'),
  }

  /**
   * The four inputs' sign-corrected z for one date, with absent ones omitted, plus whether sleep
   * is standing on only one of its two halves.
   */
  const inputsOn = (
    date: string,
  ): { present: Partial<Record<RecoveryInputKey, number>>, sleepHalfOnly: boolean } => {
    const present: Partial<Record<RecoveryInputKey, number>> = {}
    const hrv = z.hrv.get(date)
    if (hrv !== null && hrv !== undefined) present.hrv = hrv
    const rhr = z.restingHeartRate.get(date)
    if (rhr !== null && rhr !== undefined) present.restingHeartRate = rhr
    const breathing = z.respiratoryRate.get(date)
    // One-sided: a breathing rate below baseline is not evidence of better recovery, so a positive
    // sign-corrected z (meaning "lower than usual") clamps to zero rather than lifting the score.
    if (breathing !== null && breathing !== undefined) present.respiratoryRate = Math.min(breathing, 0)
    const duration = z.sleepDuration.get(date)
    const consistency = z.sleepConsistency.get(date)
    const halves = [duration, consistency].filter((half): half is number => half !== null && half !== undefined)
    let sleepHalfOnly = false
    if (halves.length > 0) {
      present.sleep = meanOf(halves)
      // A steady bedtime is a real, common case: a constant week has zero spread, so consistency's
      // z is null and duration alone stands in for sleep. That half must not go on carrying sleep's
      // full weight, or a person's most regular week would silently get counted twice as hard.
      sleepHalfOnly = halves.length === 1
    }
    return { present, sleepHalfOnly }
  }

  const out = new Map<string, RecoveryIndex>()
  for (let date = range.from; date <= range.to; date = shiftLocalDate(date, 1)) {
    const { present, sleepHalfOnly } = inputsOn(date)
    const missing = REQUIRED_INPUTS.filter((key) => present[key] === undefined)
    if (missing.length > 0) {
      out.set(date, { enough: false, missing })
      continue
    }

    const keys = (Object.keys(present) as RecoveryInputKey[])
    // Sleep standing on one half earns half its nominal weight; the freed half flows through the
    // same renormalisation an absent input already gets.
    const nominalWeight = (key: RecoveryInputKey): number =>
      key === 'sleep' && sleepHalfOnly ? RECOVERY_WEIGHTS.sleep / 2 : RECOVERY_WEIGHTS[key]
    // Weights are renormalised over the inputs actually present, so a redistribution never changes
    // what zero means - only how much each survivor carries.
    const weightPresent = keys.reduce((sum, key) => sum + nominalWeight(key), 0)
    const contributions = keys.map((key) => {
      const weight = nominalWeight(key) / weightPresent
      return { key, weight, contribution: weight * (present[key] as number) }
    })
    const composite = contributions.reduce((sum, c) => sum + c.contribution, 0)
    const score = Math.round(100 / (1 + Math.exp(-RECOVERY_SCALE * composite)))
    const distance = score - 50
    // The total movement across every present input, in the same units as `composite` but never
    // letting opposing pulls cancel each other out of the denominator. Dividing by the signed
    // composite instead (as an earlier version did) sends an individual share to infinity exactly
    // when two inputs disagree enough to pull the composite itself near zero - dividing by the sum
    // of magnitudes instead keeps every `|points|` at or under `|distance|`, always.
    const totalMovement = contributions.reduce((sum, c) => sum + Math.abs(c.contribution), 0)
    // Scaled by |distance|, not the signed distance: `contribution / totalMovement` already carries
    // each input's own sign (it agrees with the day's overall direction or it doesn't), so folding
    // a second sign in from `distance` would flip every input's points on any day that scores below
    // 50 - an input that itself pulled the score down would end up reading as a positive contributor
    // on exactly the days that reading would be most misleading.
    const inputs: RecoveryInput[] = contributions.map(({ key, weight, contribution }) => ({
      key,
      z: present[key] as number,
      weight,
      points: totalMovement === 0 ? 0 : Math.abs(distance) * (contribution / totalMovement),
    }))

    out.set(date, {
      enough: true,
      localDate: date,
      score,
      composite,
      inputs,
      degraded: [
        ...(Object.keys(RECOVERY_WEIGHTS) as RecoveryInputKey[]).filter((k) => present[k] === undefined),
        ...(sleepHalfOnly ? (['sleep'] as const) : []),
      ],
    })
  }
  return out
}

/** One day's index. The same computation as `recoveryIndexSeries` over a range of one. */
export function recoveryIndex(input: RecoveryIndexInput, on: string): RecoveryIndex {
  return recoveryIndexSeries(input, { from: on, to: on }).get(on)
    ?? { enough: false, missing: REQUIRED_INPUTS }
}

export type RecoveryBand = 'low' | 'below' | 'usual' | 'above' | 'high'

/**
 * Which of five comparative bands a score falls in.
 *
 * Deliberately NOT a readiness verdict. Google's tile says the body is recovered and ready for a
 * workout; a personal archive is not licensed to say that, so these describe distance from the
 * person's own normal and stop. The cut points are symmetric about 50 and are a copy decision, not
 * a derived one: inverting the curve at `RECOVERY_SCALE = 1.69` puts a score of 56 at a composite of
 * about 0.14 - close to a seventh of a sigma, not the quarter an earlier draft of this comment
 * claimed. That is fine; 44-56 is where this design chooses to call a day "around your usual"
 * rather than a boundary the scale implies. Re-scaling the constant later must not move these cuts
 * to keep some sigma reading true - they were never derived from it.
 */
export function bandOf(score: number): RecoveryBand {
  if (score < 25) return 'low'
  if (score < 44) return 'below'
  if (score <= 56) return 'usual'
  if (score <= 75) return 'above'
  return 'high'
}
