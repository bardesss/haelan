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
 * Null where the day has no value, where its baseline is thin, or where the spread is zero, the
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
  const out = new Map<string, number | null>()

  for (let date = range.from; date <= range.to; date = shiftLocalDate(date, 1)) {
    const value = byDate.get(date)
    if (value === undefined) {
      out.set(date, null)
      continue
    }
    const { from: windowFrom, to: windowTo } = baselineWindow(date)
    // baselineOf only ever sums and averages `history`, so the order it is handed in does not
    // matter - it used to be filtered from a copy sorted by date for no reason this function
    // depends on.
    const history = days
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
  // Unreachable at the only call site - bedtime consistency is gated at MIN_SLEEP_NIGHTS (4) - but
  // kept anyway: a spread over one value is undefined, and zero is the honest floor, exactly the
  // reasoning `baselineOf`'s own `n < 2` branch uses in `packages/core/src/query/baseline.ts`.
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
 * Measured by `scripts/probe-recovery-scale.mjs` against this household's own archive (see the
 * spec, "The scale is measured, not chosen"): `k` was set so the more extreme of the 5th/95th
 * percentile composites lands at a score of 10 or 90, with the archive's other tail landing
 * somewhat less extreme than its counterpart - this composite's own asymmetry, not a flaw in the
 * scale. A constant picked to read well in a unit test can put every real day between 47 and 54
 * and no test would notice.
 *
 * Re-measured 2026-09-19 over every day the archive can support, superseding a first measurement
 * that only covered its final ~67 days: the probe's own `from` had been anchored on the window
 * behind the LAST scored day (`recoveryWindowStart(to)`) rather than the earliest day with a full
 * window behind it, so the original 1.69 and the four `bandOf` cuts below were fit on a small tail
 * of the household's history rather than the history itself. The wider sample moved the fitted
 * scale from 1.69 to 1.76 and shifted each `bandOf` cut by a few points - a real change, not a
 * rounding difference, though not one that turns the shape of the distribution upside down either.
 *
 * **Placeholder, not settled.** This is still this household's own measurement, kept for now
 * rather than chosen for behaviour. It is expected to be refit again once there are harvested
 * Google Health scores to calibrate against - read it as provisional, not as a constant anyone has
 * signed off on.
 */
export const RECOVERY_SCALE = 1.76

/** The two inputs without which this is a different statistic wearing the same name. */
export const REQUIRED_INPUTS: readonly RecoveryInputKey[] = ['hrv', 'restingHeartRate']

export interface RecoveryInput {
  key: RecoveryInputKey
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
  /**
   * Which required inputs were absent, too thin to judge, or standing on a baseline whose spread
   * is zero - a real third case, and the one a person with perfectly regular habits for that input
   * hits, not a data shortage at all. Never empty.
   */
  missing: readonly RecoveryInputKey[]
}

export interface RecoveryIndexAvailable {
  enough: true
  /** 0-100, integer. */
  score: number
  /** The weighted composite behind it, kept so a probe can study the distribution. */
  composite: number
  inputs: readonly RecoveryInput[]
  /**
   * Optional inputs that were entirely ABSENT this day; their weight was redistributed across the
   * rest. Never includes an input that is present but standing on reduced evidence - see
   * `reducedWeight` for that case, which both surfaces must report differently from an absence.
   */
  degraded: readonly RecoveryInputKey[]
  /**
   * Optional inputs that WERE present this day but on less than their full evidence, and so
   * carried less than their nominal weight rather than being redistributed away entirely. Today
   * this can only ever be `['sleep']`, for the case `sleepHalfOnly` computes below: one of
   * duration or bedtime consistency was observed and the other was not, so sleep stands on half
   * its usual weight rather than being dropped. A reader must not describe an input in this list
   * the way it would describe one in `degraded` - the tile and the MCP tool both used to say
   * "computed without last week's sleep" on a day sleep was very much present, just at half
   * weight, which is the defect this field exists to make impossible to repeat.
   */
  reducedWeight: readonly RecoveryInputKey[]
}

/**
 * A union rather than `RecoveryIndex | null`, following `TrainingLoad`: a caller cannot read a
 * score without having passed the gate, and the unavailable case still carries something worth
 * rendering.
 */
export type RecoveryIndex = RecoveryIndexUnavailable | RecoveryIndexAvailable

/**
 * The five raw series, already filtered to merged daily rows covering every date that scoring the
 * caller's range needs. A caller scoring one date `on` fetches `recoveryWindowStart(on)` through
 * `on`. A caller scoring a `range` must fetch from `recoveryWindowStart(range.from)` - not from a
 * window anchored on `range.to` - through `range.to`, because each date in the range carries its
 * own baseline-plus-sleep-week window behind it, and the earliest of those belongs to the range's
 * earliest date. `apps/web/src/data/useRecoveryIndex.ts`'s `recoveryFetchRange` does this correctly.
 * A day nobody wore a device is ABSENT rather than present as zero.
 */
export interface RecoveryIndexInput {
  hrv: readonly DayValue[]
  restingHeartRate: readonly DayValue[]
  respiratoryRate: readonly DayValue[]
  asleepMinutes: readonly DayValue[]
  bedtimeMinutes: readonly DayValue[]
}

/**
 * Every `RecoveryIndexInput` field's own `/series` metric and aggregation - the mapping five call
 * sites once held five independent copies of (apps/web/src/data/useRecoveryIndex.ts,
 * apps/server/src/mcp/tools/recovery.ts, scripts/probe-recovery-scale.mjs,
 * apps/server/test/mcp-fixtures.ts, apps/web/test/recovery-index-tile.test.tsx), with nothing
 * holding the copies to each other: a sixth input, or a changed agg for one already here, meant
 * finding and editing all five by hand, and no test noticed when one drifted.
 *
 * `key` is the `RecoveryIndexInput` field the pair fills. A caller that fetches `/series` builds
 * its request from `metric`/`agg` here; a caller that already has the five series in hand (the
 * probe, which reads `daily` rows directly) still keys its own local shape by `key`, so the field
 * name a value is stored under is never re-typed by hand either.
 */
export interface RecoveryMetricSource {
  key: keyof RecoveryIndexInput
  metric: string
  agg: 'last' | 'sum'
}

export const RECOVERY_METRIC_SOURCES: readonly RecoveryMetricSource[] = [
  { key: 'hrv', metric: 'daily_hrv', agg: 'last' },
  { key: 'restingHeartRate', metric: 'resting_heart_rate', agg: 'last' },
  { key: 'respiratoryRate', metric: 'respiratory_rate', agg: 'last' },
  { key: 'asleepMinutes', metric: 'sleep_asleep_minutes', agg: 'sum' },
  { key: 'bedtimeMinutes', metric: 'sleep_bedtime_minutes', agg: 'last' },
]

/**
 * The `events.kind` a harvested Google Health recovery score is stored under
 * (`apps/server/src/admin.ts`'s `harvest-recovery` console command - there is no API for this
 * number, so it is typed in by hand off the app's own history screens and kept as an event rather
 * than a schema change).
 *
 * Shared here, a browser-safe module, rather than kept only in admin.ts: `apps/web/src/data/
 * dayAnnotations.ts` needs to name it too. A harvested score is real household data worth keeping,
 * but it is not something that happened to the person that day the way a note or an illness event
 * is, and every chart on every page marking a day an `events` row falls on would otherwise grow a
 * marker for each of the (up to) sixty scores one harvest run writes - sixty markers on every chart
 * in the app for what is, to every one of those charts, unrelated data.
 */
export const RECOVERY_HARVEST_EVENT_KIND = 'google_recovery_score'

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

  const z = {
    hrv: zSeries(input.hrv, range, 'up'),
    restingHeartRate: zSeries(input.restingHeartRate, range, 'down'),
    respiratoryRate: zSeries(input.respiratoryRate, range, 'down'),
    sleepDuration: zSeries(sleep.duration, range, 'up'),
    sleepConsistency: zSeries(sleep.consistency, range, 'down'),
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
      weight,
      points: totalMovement === 0 ? 0 : Math.abs(distance) * (contribution / totalMovement),
    }))

    out.set(date, {
      enough: true,
      score,
      composite,
      inputs,
      // Entirely absent, never sleep-at-half-weight: that case is present, just reduced, and
      // belongs in reducedWeight below - see RecoveryIndexAvailable's own comment on why the two
      // must not be conflated.
      degraded: (Object.keys(RECOVERY_WEIGHTS) as RecoveryInputKey[]).filter((k) => present[k] === undefined),
      reducedWeight: sleepHalfOnly ? ['sleep'] : [],
    })
  }
  return out
}

/** One day's index. The same computation as `recoveryIndexSeries` over a range of one. */
export function recoveryIndex(input: RecoveryIndexInput, on: string): RecoveryIndex {
  const result = recoveryIndexSeries(input, { from: on, to: on }).get(on)
  // `recoveryIndexSeries`'s date loop runs from `range.from` to `range.to` inclusive and sets the
  // map entry for every date it visits, so a range of exactly `{ from: on, to: on }` always sets
  // `on`. A missing entry here cannot mean "not enough data" - that state already has its own,
  // checked, representation - so treating it as one would name both required inputs as missing
  // without having looked at either. If this ever fires, `recoveryIndexSeries`'s date loop has
  // stopped covering the range it is given: that is a bug in this file, not a data state.
  if (result === undefined) {
    throw new Error(`recoveryIndexSeries did not score ${on} against a range of itself - this is a bug in recoveryIndexSeries, not a data state`)
  }
  return result
}

export type RecoveryBand = 'low' | 'below' | 'usual' | 'above' | 'high'

/**
 * Which of five comparative bands a score falls in.
 *
 * Deliberately NOT a readiness verdict. Google's tile says the body is recovered and ready for a
 * workout; a personal archive is not licensed to say that, so these describe distance from the
 * person's own normal and stop.
 *
 * The cut points are derived, not round numbers: they mark the score below which the bottom tenth
 * of days fall, the score below which the next fifth fall, and so on outward from the middle - NOT
 * symmetrically, because there is no reason to expect the composite is: bottom tenth / next fifth /
 * middle two-fifths / next fifth / top tenth. Each cut was found by reading that percentile of the
 * composite straight off `scripts/probe-recovery-scale.mjs`'s output against this household's
 * archive, then mapping it through the same logistic curve `recoveryIndexSeries` uses to turn a
 * composite into a score, at the current `RECOVERY_SCALE`. Deliberately not estimated from a single
 * tail under an assumed distribution shape - an earlier version of this comment did that, and two
 * reasonable-looking single-tail estimates disagreed by several points because the composite is not
 * symmetric. Reading the percentile the cut actually needs, rather than inferring it, is what makes
 * that disagreement impossible. That derivation depends on this household's archive, so the numbers
 * behind it are not repeated here - what is fixed, and what a refit must reproduce, is the
 * percentile intent below.
 *
 * **If `RECOVERY_SCALE` is ever refit** against harvested Google Health scores, these five cuts do
 * not follow along automatically - the probe must be re-run and these five cuts re-derived from the
 * same intent (bottom tenth, next fifth, middle two-fifths, next fifth, top tenth) against the new
 * scale. Leaving the old cuts in place after a refit would silently change what fraction of days
 * each band actually covers.
 *
 * Re-derived 2026-09-19 alongside `RECOVERY_SCALE`'s own re-measurement (see its comment): the
 * probe that produced the first four cuts here had the same `from` bug that gave `RECOVERY_SCALE`
 * its first, too-narrow sample, so these moved too, by a few points each.
 */
export function bandOf(score: number): RecoveryBand {
  if (score < 17) return 'low'
  if (score < 33) return 'below'
  if (score <= 64) return 'usual'
  if (score <= 83) return 'above'
  return 'high'
}
