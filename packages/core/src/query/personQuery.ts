import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, max, min } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { readSourceActivity } from './sourceActivity.ts'
import { readAllTime } from './allTime.ts'
import type { AllTime } from './allTime.ts'
import type { SourceActivity, SourceStatus } from './sourceActivity.ts'
import { daily, people, samples, overrides as overridesTable, SESSION_KINDS, sources } from '../db/schema/index.ts'
import { EXERCISE_TYPES } from '../api/enums.ts'
import { MERGED_SOURCE, PROVIDER_SOURCE } from '../derive/rollup.ts'
import type { SampleLike } from '../derive/rollup.ts'
import { metricSpec } from '../derive/metrics.ts'
import { namedSourcesOf } from '../store/sourceAliases.ts'
import { ConfigError } from '../errors.ts'
import { baselinesOver, baselineWindow, BASELINE_WINDOW_DAYS } from './baseline.ts'
import type { Baseline } from './baseline.ts'
import { coverageIsMeaningful } from './coverageSignal.ts'
// Aliased: the class has a method of the same name, and an unqualified call inside it
// resolving to the module import rather than the method is technically fine and genuinely
// confusing to read.
import { comparePeriods as comparePeriodPoints, INSIGHT_MIN_COVERAGE } from './insights.ts'
import type { Insight, PeriodPoint } from './insights.ts'
import { localDateOf, localMinuteOf, shiftLocalDate, widenedUtcWindow } from '../derive/localDay.ts'
import { thin } from './downsample.ts'
import type { Thinned } from './downsample.ts'
import { readIntraday, readIntradayWindow } from './intraday.ts'
import type { IntradayResult } from './intraday.ts'
import { SampleKeys } from '../db/keys.ts'
import { applyToSamples } from '../derive/overrides.ts'
import type { OverrideLike } from '../derive/overrides.ts'
import { selectHourWinners } from '../derive/merge.ts'
import { loadPriority } from '../store/sourcePriority.ts'
import { readSleepNights } from './sleepNights.ts'
import type { Night } from './sleepNights.ts'
import { readSessions, readSession } from './sessions.ts'
import type { WorkoutSession } from './sessions.ts'
import { mergedWorkoutFor, mergeRuleFor, readMergedWorkouts } from './mergedWorkouts.ts'
import { readWorkoutCardioLoad, readWorkoutSplits, readWorkoutRoute } from './workoutDerived.ts'
import type { CardioLoad } from '../api/cardioLoad.ts'
import type { FilledSplit } from '../api/splitHeartRate.ts'
import type { RoutePoint } from './workoutDerived.ts'
import { trendOf } from './trend.ts'
import type { TrendPoint } from './trend.ts'
import { readChanges } from './changes.ts'
import type { ChangesResult } from './changes.ts'
import { NoteStore } from '../store/notes.ts'
import type { StoredNote } from '../store/notes.ts'
import { EventStore } from '../store/events.ts'
import type { StoredEvent } from '../store/events.ts'
import { writeProjection } from './projection.ts'
import { readGlance } from './glance.ts'
import type { Glance } from './glance.ts'
import { readGlanceCalendar } from './glanceCalendar.ts'
import type { GlanceCalendar } from './glanceCalendar.ts'

export interface DailyPoint {
  localDate: string
  value: number
  /** Null where there was never a basis to measure hours: a sleep row or a provider row. */
  coverage: number | null
  source: string
  sourceMix: string | null
  /**
   * When this row was last written. Null for a row derived before M3b added the column, and for
   * any row a rebuild has not touched since. The HTTP surface's conditional requests are the
   * reason this is here: an ETag over `daily` needs the newest stamp among the rows an answer
   * drew on, and there was no reader over the column anywhere in core until now.
   */
  updatedAtMs: number | null
  /**
   * True when the daily name itself has no row for this date and the value shown is
   * DEVICE_ROLLED_EQUIVALENT's intraday mean standing in for it. A household that never syncs
   * the daily type, or a day the summary has not landed yet, gets a real number here rather than
   * a gap -- but it is not the device's own daily reading, and every consumer that shows this
   * point needs to say so rather than presenting it as one.
   */
  filled: boolean
}

export interface SeriesResult {
  points: DailyPoint[]
  reduction: Thinned<DailyPoint>['reduction']
}

/**
 * The metrics an instance writes only when Google is connected, and the metric a phone's own
 * samples roll up into instead.
 *
 * The catalogue owns metric names, and it owns two families for the same reading, because Google
 * publishes a daily summary as its own data type: `daily-heart-rate-variability` lands on
 * `daily_hrv` and `daily-oxygen-saturation` on `daily_spo2`. A phone has no daily record for
 * either - Health Connect's HRV and SpO2 records are readings with a time, and the device computes
 * no summary - so its samples are filed under the intraday type and rolled up to `hrv` and `spo2`
 * by `deriveDay`. Two names, one reading, and which of them exists is a fact about how the
 * instance is connected rather than about the person.
 *
 * So a read of the daily name falls back to the device-rolled one when the daily name has no rows.
 * This is the rule the merge already applies to numbers: `mergeDay` fills an hour from a source
 * that has it, and a name nothing wrote is the same gap one level up. It is deliberately not a
 * second derivation and not a bumped version: the mean it reads was already computed, and reading
 * it changes no row.
 *
 * `respiratory_rate` is not here, and that is the asymmetry worth knowing. Google summarises a
 * whole day of breathing; a phone can only summarise the night, which is what
 * `sleep-respiratory-rate-sleep-summary` rolls up to under its own name, `sleep_respiratory_rate`.
 * Mapping `respiratory_rate` onto it would answer a question about the day with a number about the
 * night, so the day's card stays empty rather than lying in the right shape. Measured on this
 * household's two instances on 2026-09-14, that card is empty on both, because the daily type has
 * never been synced on either; the companion path is not the reason.
 */
const DEVICE_ROLLED_EQUIVALENT: Readonly<Record<string, { metric: string, agg: string }>> = {
  daily_hrv: { metric: 'hrv', agg: 'mean' },
  daily_spo2: { metric: 'spo2', agg: 'mean' },
}

/**
 * The widest span `intradayWindow` will read.
 *
 * 48 rather than 24 because the two questions the window exists for both cross a midnight: a night
 * runs 23:15 to 07:02, and a caller asking for "yesterday and today" of a person in a different
 * zone is not making a mistake. It is the number M8's design chose independently for the same
 * function, and taking that one rather than picking a second means the HTTP route and the tool
 * surface cannot come to disagree about what is too much to ask for.
 */
const MAX_WINDOW_HOURS = 48

const MAX_WINDOW_MS = MAX_WINDOW_HOURS * 3_600_000

/**
 * The metrics that count as "this day has something to show" for the dashboard's day navigation
 * (`daysWithData`, `nearestDayWithData`): the glance's own day figures, plus the intraday heart
 * rate trace. A night counts through its derived `sleep_asleep_minutes` row, already in this
 * list, rather than through the raw sleep session: derivation has already dropped a session an
 * override excluded and a nap-only night `assembleNights` turned into no night at all, so the
 * daily row is the only place those two are already accounted for.
 */
export const GLANCE_DAY_METRICS: readonly string[] = [
  'steps', 'sleep_asleep_minutes', 'resting_heart_rate', 'daily_hrv',
  'active_minutes_light', 'active_minutes_moderate', 'active_minutes_vigorous', 'heart_rate',
]

/**
 * Everything a surface asks of the store, bound to one person at construction.
 *
 * Master design section 11 requires the binding to live here rather than in the callers, because
 * a tool that forgets a WHERE clause must not be able to leak another member's data. There is
 * deliberately no unbound variant and no optional person parameter: the guarantee is that you
 * cannot express the question without saying whose data it is about.
 *
 * Every method validates its own arguments and throws rather than returning an emptiness. The
 * direct consumers are an HTTP query string and a language model's tool arguments, and a query
 * that quietly returns nothing becomes an agent saying there is no data for that period, which
 * is a false statement about somebody's health record made with total confidence.
 */
export class PersonQuery {
  readonly #db: DbOrTx

  readonly #personId: string

  constructor(db: DbOrTx, personId: string) {
    this.#db = db
    this.#personId = personId
  }

  /**
   * The daily rows for a metric over an inclusive range, oldest first.
   *
   * With no `source`, this answers what happened that day: the merged row where we reconciled
   * one, and the provider row where Google already had. Both mean the day rather than one
   * device, which is what `daily.source`'s own column comment says they differ only in who
   * reconciled. Passing a source id reads that device instead, which is what keeps a merge
   * inspectable against the rows underneath it, and passing `merged` still means only the rows
   * we merged ourselves.
   */
  series(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
    points?: number
  }): SeriesResult {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireOptionalPositiveInteger('points', input.points)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const source = input.source
    // One reader for both names, because one rule has to pick the row on both sides. The rolled
    // name is a fallback for the days the requested name is silent about, and a day both names
    // hold a row for is still one answer, not two to weigh. Read raw, the fallback was a last-wins
    // Map over a query ordered by localDate alone: that is the prefix of `daily_natural`, so SQLite
    // answered it in rowid order and the tie between a merged row and a provider row on one date
    // fell to whichever arrival was written last, while every other day of the series said merged.
    // Narrowed to a source there is nothing to choose, which is why this branches on `source` too.
    const pointsFrom = (metric: string, agg: string): DailyPoint[] => {
      const rows = this.#rowsOf(metric, agg, input.from, input.to, source)
      return source === undefined ? preferMerged(rows) : rows
    }

    const ofName = pointsFrom(input.metric, input.agg)

    // Per day, not per series: a person can have the daily name for the days Google was connected
    // and the rolled up name for the days the phone covered, and a rule that fired only on an
    // entirely empty series would answer a range like that with the Google half alone. See
    // DEVICE_ROLLED_EQUIVALENT above for why the two names exist and why this is not a derivation.
    const rolled = DEVICE_ROLLED_EQUIVALENT[input.metric]
    const rolledByDate = rolled === undefined
      ? new Map<string, DailyPoint>()
      : new Map(pointsFrom(rolled.metric, rolled.agg).map((point) => [point.localDate, point]))
    const result = withFilledDays(ofName, rolledByDate)

    if (input.points === undefined) return { points: result, reduction: null }

    // Daily rows are evenly spaced by construction, one per local date, so the index is the
    // correct x to thin on. Parsing each localDate back into an instant would buy nothing and
    // add a timezone question this series does not have.
    const indexed = result.map((point, index) => ({ index, point }))
    const thinned = thin(indexed, input.points, {
      method: 'lttb',
      x: (entry) => entry.index,
      y: (entry) => entry.point.value,
    })
    return { points: thinned.points.map((entry) => entry.point), reduction: thinned.reduction }
  }

  /**
   * Whether each of this person's sources is still reporting, judged against its own cadence.
   *
   * Takes no range, unlike every other reader here: staleness is a question about the whole
   * history, and a range would make "has this stopped" mean "did it report inside the window the
   * reader happens to be looking at", which is a different and much less useful question.
   */
  /**
   * Every figure the all-time page shows, in one call.
   *
   * No range, and no arguments at all: these are the questions the range on screen cannot answer,
   * which is the whole reason M6 exists. One call rather than four because they are one page, and
   * four round trips for one screen is four chances to render it half built.
   */
  allTime(): AllTime {
    return readAllTime(this.#db, this.#personId)
  }

  sourceActivity(input: { today: string }): SourceActivity[] {
    requireDate('today', input.today)
    return readSourceActivity(this.#db, this.#personId, input)
  }

  /**
   * The glance (M9a): last night, today's recovery and today so far in one call, for the web
   * dashboard and the native app alike. `today` and `nowMs` are the caller's, because the person's
   * zone and the clock live above this layer; `nameOf` resolves a source id to the name the person
   * gave it, defaulting to the id.
   *
   * `day` (M9c: day navigation) asks for a finished day instead of today: it must be strictly
   * before `today`, and `dayEndMs` - the last millisecond of that local day, which the caller
   * computes with `localMidnightMs` since core has no timezone of its own - is then required, and
   * the whole glance is built as if `nowMs` were `dayEndMs`.
   */
  glance(input: {
    today: string
    nowMs: number
    nameOf?: (sourceId: string) => string
    day?: string
    dayEndMs?: number
  }): Glance {
    requireDate('today', input.today)
    requireFiniteNumber('nowMs', input.nowMs)
    if (input.day !== undefined) {
      requireDate('day', input.day)
      if (input.day >= input.today) {
        throw new ConfigError(`day '${input.day}' must be before today '${input.today}'`)
      }
      if (input.dayEndMs === undefined) {
        throw new ConfigError('dayEndMs is required when day is given')
      }
      requireFiniteNumber('dayEndMs', input.dayEndMs)
    } else if (input.dayEndMs !== undefined) {
      throw new ConfigError('dayEndMs was given without day')
    }
    return readGlance(this, {
      today: input.today,
      nowMs: input.nowMs,
      nameOf: input.nameOf ?? ((id) => id),
      day: input.day,
      dayEndMs: input.dayEndMs,
    })
  }

  /**
   * The calendar (M9c): a month of days with data, each with its sleep and steps verdicts, for
   * the dashboard's calendar picker. `today` decides both which days of the current month are
   * shown (never a future one) and whether the month's own last day counts as partial for steps;
   * see `readGlanceCalendarRaw` for the reads and `judgeCalendarDay` for the verdicts.
   */
  glanceCalendar(input: { month: string, today: string }): GlanceCalendar {
    return readGlanceCalendar(this, input)
  }

  /**
   * The person's own baseline for a metric as of a date.
   *
   * The window ends the day BEFORE `on`, so a reading is never part of the baseline it is
   * judged against. Including it pulls the centre toward itself and biases its own z score
   * toward zero, and the bias is largest exactly when history is shortest.
   */
  baseline(input: {
    metric: string
    agg: string
    on: string
    windowDays?: number
    source?: string
  }): Baseline | null {
    requireMetricAndAgg(input.metric, input.agg)
    requireDate('on', input.on)
    return this.baselines({ ...input, from: input.on, to: input.on }).get(input.on) ?? null
  }

  /**
   * Every day's own baseline from `from` through `to`, each exactly what `baseline({ on })` answers
   * for that day, from one read of the rows under all their windows rather than one read a day.
   * `baseline` itself is this over a single day, so the two cannot come to disagree about a window,
   * the coverage rule or the arithmetic. The dashboard's strips (a week, each dot judged against its
   * own day's usual) and the calendar (a month) are why it exists.
   */
  baselines(input: {
    metric: string
    agg: string
    from: string
    to: string
    windowDays?: number
    source?: string
  }): Map<string, Baseline | null> {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const windowDays = input.windowDays ?? BASELINE_WINDOW_DAYS
    requirePositiveInteger('windowDays', windowDays)
    const { points } = this.series({
      metric: input.metric, agg: input.agg,
      from: baselineWindow(input.from, windowDays).from, to: baselineWindow(input.to, windowDays).to, source: input.source,
    })

    // A barely observed day is a systematic undercount, not a low reading, and sixty of them
    // build a centre a properly worn day then scores a large z against. The insight gate refuses
    // such a period outright; a baseline can do better and drop the days rather than the answer.
    // Oldest first, as series returns them, so each window sums in the same order a read of that
    // window alone would.
    const judgeCoverage = coverageIsMeaningful(input.metric)
    const values = new Map(points
      .filter((point) => !(judgeCoverage && point.coverage !== null && point.coverage < INSIGHT_MIN_COVERAGE))
      .map((point) => [point.localDate, point.value]))

    const days: string[] = []
    for (let day = input.from; day <= input.to; day = shiftLocalDate(day, 1)) days.push(day)
    return baselinesOver(values, days, windowDays)
  }

  /**
   * A range against the range of equal length immediately before it. Suppression is the pure
   * function's decision; this only fetches the two periods, says how long they are, and says
   * whether coverage means anything for this metric.
   */
  comparePeriods(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
  }): Insight {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const periodDays = daysBetween(input.from, input.to)
    const previousTo = shiftLocalDate(input.from, -1)
    const previousFrom = shiftLocalDate(previousTo, -(periodDays - 1))

    // The comparison period is derived here, never supplied. Stepping a wide range back by its
    // own length lands outside the calendar, and the ConfigError series() then threw named a date
    // the caller had never written: `from must be a YYYY-MM-DD local date, got '-008000-01'` in
    // answer to a request that said 1000-01-01. Whoever read that had a range to go and find in
    // their own code that was not in it. Refused here instead, in terms of what was passed, and
    // saying where the range the message does not name came from.
    if (!ISO_DATE.test(previousFrom) || !ISO_DATE.test(previousTo)) {
      throw new ConfigError(
        `from '${input.from}' to '${input.to}' spans ${periodDays} days, and the period of equal `
        + 'length immediately before it, which is what this compares against, starts before year 0001',
      )
    }

    // Coverage is a fraction of the day's hours, so a once-a-day metric reads 0.0417 when it is
    // perfect. Handing that number to a gate built for continuously sampled data suppresses the
    // whole Recovery page forever. Null says the period cannot be judged on coverage, which the
    // gate already handles correctly.
    const judgeCoverage = coverageIsMeaningful(input.metric)
    const fetch = (from: string, to: string): PeriodPoint[] => this.series({
      metric: input.metric, agg: input.agg, from, to, source: input.source,
    }).points.map((point) => ({
      localDate: point.localDate,
      value: point.value,
      coverage: judgeCoverage ? point.coverage : null,
    }))

    const insight = comparePeriodPoints({
      current: fetch(input.from, input.to),
      previous: fetch(previousFrom, previousTo),
      periodDays,
    })

    return {
      ...insight,
      currentRange: { from: input.from, to: input.to },
      previousRange: { from: previousFrom, to: previousTo },
    }
  }

  /**
   * One day of per-minute samples for a metric, pivoted onto one row per minute per source and
   * thinned for a chart. See `readIntraday` for why source is never chosen for the caller.
   */
  intraday(input: {
    metric: string
    localDate: string
    points?: number
    sourceId?: string
  }): IntradayResult {
    requireMetric(input.metric)
    requireDate('localDate', input.localDate)
    requireOptionalPositiveInteger('points', input.points)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    return readIntraday(this.#db, {
      personId: this.#personId,
      metric: input.metric,
      localDate: input.localDate,
      points: input.points,
      sourceId: input.sourceId,
    })
  }

  /**
   * Per-minute samples over an arbitrary UTC span, thinned against that span.
   *
   * The budget is the reason this is separate from `intraday`: a workout is minutes long inside a
   * day that is 1,440, and a day-wide budget spends almost none of itself on it.
   *
   * Bounded at 48 hours, which is this surface's only span limit and has to be: `intraday` is
   * bounded by construction at one local day, while the reader underneath this one selects every
   * sample row in the span into JS before pivoting, and a year of heart rate is about 1.5 million
   * of them. `startMs: 0` is a perfectly plausible thing for a language model to send.
   */
  intradayWindow(input: {
    metric: string
    startMs: number
    endMs: number
    points?: number
    sourceId?: string
  }): IntradayResult {
    requireMetric(input.metric)
    requireFiniteNumber('startMs', input.startMs)
    requireFiniteNumber('endMs', input.endMs)
    // Before the span cap, never after. A reversed window is not a wide one, and a cap tested
    // first would answer `startMs` after `endMs` with a complaint about a limit it does not
    // exceed - sending whoever read it to shorten a window that was never too long.
    if (input.startMs > input.endMs) {
      throw new ConfigError(`startMs ${input.startMs} is after endMs ${input.endMs}`)
    }
    if (input.endMs - input.startMs > MAX_WINDOW_MS) {
      throw new ConfigError(
        `the window must be at most ${MAX_WINDOW_HOURS} hours, got ${
          Math.round((input.endMs - input.startMs) / 3_600_000)} hours. Use series or intraday for `
        + 'a longer span, which read derived rows rather than every sample in it.',
      )
    }
    requireOptionalPositiveInteger('points', input.points)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    return readIntradayWindow(this.#db, {
      personId: this.#personId,
      metric: input.metric,
      startMs: input.startMs,
      endMs: input.endMs,
      points: input.points,
      sourceId: input.sourceId,
    })
  }

  /**
   * Steps counted up to one minute of the local day, per local date, for the glance's pace.
   *
   * The minute is today's last step reading, read under its own offset, and every earlier date -
   * today included - is cut at the same local minute. `today` is returned separately from `sums`
   * because the glance's pace compares itself against its own moment, not against `daily.steps`,
   * which lags until the derivation queue drains: comparing today's *derived* total (as of
   * whenever it last ran) against a band cut at the *sample* cutoff mixes two different instants
   * and can call an ordinary lag "behind" (review round 1, finding 2).
   *
   * Each date's rows go through the overrides derivation applies, filtered to the two sample
   * aggregates a daily sum actually feeds from (rollUpDay's FEEDS.sum: 'raw' and 'sum' - a mean or
   * a max row must not be added into a step count), and through selectHourWinners, so the count is
   * the daily total's own arithmetic stopped early: a phone and a watch in one hour are counted
   * once, by the person's priority. One range read for the whole window (drizzle prepares per
   * .run(), and sixty per-day reads were the rebuild's OOM).
   */
  stepsUpToMinute(input: { today: string, from: string, to: string }): { atMs: number, minuteOfDay: number, today: number, sums: Map<string, number> } | null {
    const keys = new SampleKeys(this.#db)
    const personRef = keys.personRefIfKnown(this.#personId)
    const metricRef = keys.metricRefIfKnown('steps')
    if (personRef === undefined || metricRef === undefined) return null
    const rows = this.#db.select().from(samples).where(and(
      eq(samples.personRef, personRef), eq(samples.metricRef, metricRef),
      gte(samples.utcMs, widenedUtcWindow(input.from).start), lte(samples.utcMs, widenedUtcWindow(input.today).end),
    )).all().map((row) => keys.sampleText(row))
    // The same sample-scope overrides derivation applies, read the way readWindow reads them.
    const overrides: OverrideLike[] = this.#db.select().from(overridesTable)
      .where(and(eq(overridesTable.personId, this.#personId), eq(overridesTable.scope, 'sample'))).all()
      .map((row) => ({ scope: row.scope, targetKey: row.targetKey, action: row.action, correctedValue: row.correctedValue ?? null }))
    // 'raw' and 'sum' only: the same two sample aggregates rollUpDay's own FEEDS.sum reads for the
    // daily total (derive/rollup.ts), so a source that also reports a min/mean/max row for steps
    // cannot double count here what the daily total never counted from it either.
    const kept = applyToSamples(rows, overrides).filter((r) => r.agg === 'raw' || r.agg === 'sum')
    const byDate = new Map<string, SampleLike[]>()
    for (const row of kept) {
      const date = localDateOf(row.utcMs, row.tzOffsetMinutes)
      const list = byDate.get(date)
      if (list) list.push(row)
      else byDate.set(date, [row])
    }
    const last = (byDate.get(input.today) ?? []).reduce<SampleLike | null>((best, r) => (best === null || r.utcMs > best.utcMs ? r : best), null)
    if (last === null) return null
    const minuteOfDay = localMinuteOf(last.utcMs, last.tzOffsetMinutes)
    const priority = loadPriority(this.#db, this.#personId)
    const sumAt = (dayRows: SampleLike[]): number => {
      const early = dayRows.filter((r) => localMinuteOf(r.utcMs, r.tzOffsetMinutes) <= minuteOfDay)
      return selectHourWinners(early, priority).winning.reduce((s, r) => s + (r.value ?? 0), 0)
    }
    const sums = new Map<string, number>()
    for (const [date, dayRows] of byDate) {
      if (date < input.from || date > input.to) continue
      sums.set(date, sumAt(dayRows))
    }
    return { atMs: last.utcMs, minuteOfDay, today: sumAt(byDate.get(input.today)!), sums }
  }

  /**
   * The local dates in `[from, to]` that have anything for the dashboard to show: a `daily` row
   * for one of `GLANCE_DAY_METRICS`. Sorted.
   *
   * One query, never a per-day loop: drizzle prepares a statement per `.run()`, and a loop over
   * the days in a range was the rebuild's own OOM before it was hoisted out (see
   * `drizzle-prepares-per-run`). Sessions are deliberately not consulted here: a raw sleep session
   * can be excluded by a session-scope override, or be a nap-only night `assembleNights` turns
   * into no night at all, and either way derivation has already resolved that into whether
   * `sleep_asleep_minutes` (in `GLANCE_DAY_METRICS`) got written - reading the session directly
   * would land navigation on a day the dashboard shows nothing for.
   */
  daysWithData(input: { from: string, to: string }): string[] {
    requireRange(input.from, input.to)
    const dailyDates = this.#db.selectDistinct({ localDate: daily.localDate }).from(daily).where(and(
      eq(daily.personId, this.#personId),
      gte(daily.localDate, input.from),
      lte(daily.localDate, input.to),
      inArray(daily.metric, GLANCE_DAY_METRICS as readonly string[]),
    )).all().map((row) => row.localDate)
    return [...new Set(dailyDates)].sort()
  }

  /**
   * The nearest local date with data (same definition as `daysWithData`) strictly before or after
   * `on`, or null when there is none. `until`, when given, is the far edge of the search: a day
   * beyond it does not count as found, which is what lets a caller page day by day without ever
   * landing past a range it was told to stay inside.
   *
   * One query, like `daysWithData` and for the same reason sessions are absent from it, bounded by
   * `on` and `until` in the WHERE clause rather than filtered afterwards, so a day beyond `until`
   * is never fetched only to be discarded.
   */
  nearestDayWithData(input: { on: string, direction: 'before' | 'after', until?: string }): string | null {
    requireDate('on', input.on)
    if (input.until !== undefined) requireDate('until', input.until)

    const isBefore = input.direction === 'before'
    const bound = this.#db.select({ bound: isBefore ? max(daily.localDate) : min(daily.localDate) })
      .from(daily).where(and(
        eq(daily.personId, this.#personId),
        inArray(daily.metric, GLANCE_DAY_METRICS as readonly string[]),
        isBefore ? lt(daily.localDate, input.on) : gt(daily.localDate, input.on),
        input.until === undefined ? undefined : (isBefore ? gte(daily.localDate, input.until) : lte(daily.localDate, input.until)),
      )).get()?.bound ?? null
    return bound
  }

  /** The person's sleep nights in a local date range. See `readSleepNights` for the grouping. */
  sleepNights(input: {
    from: string
    to: string
    sourceId?: string
  }): Night[] {
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    return readSleepNights(this.#db, {
      personId: this.#personId,
      from: input.from,
      to: input.to,
      sourceId: input.sourceId,
    })
  }

  /**
   * Sessions of one kind in a local date range. See `readSessions` for why kind is load bearing.
   *
   * `type` and `last` exist for one question an agent asks constantly and the list form answers
   * badly: the last run. Both are validated here rather than in the reader, because this is the
   * boundary an HTTP query string and a model's tool arguments arrive at.
   */
  sessions(input: {
    kind: 'sleep' | 'exercise'
    from: string
    to: string
    sourceId?: string
    type?: string
    last?: number
  }): WorkoutSession[] {
    requireSessionKind(input.kind)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    requireExerciseType(input.type)
    // A sleep row has no exercise type to match, so this combination answers an empty list for
    // every range and every household - and an agent reads an empty list as "you did not run in
    // August" rather than as "that question is malformed". Refused for the same reason a metric
    // typo is: the only two callers are an HTTP query string and a model's tool arguments, and
    // neither of them can tell a true empty answer from a question that could never be answered.
    if (input.kind === 'sleep' && input.type !== undefined) {
      throw new ConfigError(`kind 'sleep' has no exercise type to filter on, so '${input.type}' would match nothing. Use kind 'exercise' to filter by type.`)
    }
    requireOptionalPositiveInteger('last', input.last)
    // Exercise with no source named is the one read that merges: one workout per event, whichever
    // sources recorded it (mergedWorkouts.ts). Naming a source is asking for that device's own
    // rows, so it keeps the raw answer it always had, and sleep keeps its own nightly merge.
    if (input.kind === 'exercise' && input.sourceId === undefined) {
      return readMergedWorkouts(this.#db, {
        personId: this.#personId,
        from: input.from,
        to: input.to,
        type: input.type,
        last: input.last,
        rule: mergeRuleFor(this.#db, this.#personId),
      })
    }
    return readSessions(this.#db, {
      personId: this.#personId,
      kind: input.kind,
      from: input.from,
      to: input.to,
      sourceId: input.sourceId,
      type: input.type,
      last: input.last,
    })
  }

  /**
   * One session by id, or null. Named sessionById rather than session because it sits one line
   * from sessions() and the singular would misread at a glance.
   *
   * No requireSource call: the session's own row names its source, and a caller who has the id
   * is not choosing between devices. No requireSessionKind either; see readSession.
   *
   * An exercise session answers as the merged workout it belongs to, the same object the list
   * answers for it, even when the id names an alternate (mergedWorkoutFor says why old links need
   * that). cardioLoad, workoutSplits and workoutRoute below all start here, so each of them reads
   * the merged workout too rather than one copy of it.
   */
  sessionById(input: { sessionId: string }): WorkoutSession | null {
    if (input.sessionId.trim() === '') throw new ConfigError('sessionId is required')
    const session = readSession(this.#db, { personId: this.#personId, sessionId: input.sessionId })
    if (session === null || session.kind !== 'exercise') return session
    return mergedWorkoutFor(this.#db, {
      personId: this.#personId, session, rule: mergeRuleFor(this.#db, this.#personId),
    })
  }

  /**
   * One workout's cardio load, Haelan's own number rather than Google's.
   *
   * Null for a session id naming nothing, which is the same answer `sessionById` gives and for the
   * same reason: this reader cannot tell an unknown id from somebody else's, and must not.
   */
  cardioLoad(input: { sessionId: string }): CardioLoad | null {
    const session = this.sessionById(input)
    if (session === null) return null
    return readWorkoutCardioLoad(this.#db, { personId: this.#personId, session })
  }

  /**
   * A workout's automatic splits and recorded laps, heart rate filled in from the session's own
   * trace where the provider left it null. Null for a session id naming nothing, the same answer
   * `cardioLoad` gives and for the same reason: this reader cannot tell an unknown id from
   * somebody else's, and must not.
   */
  workoutSplits(input: { sessionId: string }): { autoSplits: FilledSplit[], laps: FilledSplit[] } | null {
    const session = this.sessionById(input)
    if (session === null) return null
    return readWorkoutSplits(this.#db, { personId: this.#personId, session })
  }

  /**
   * A workout's GPS route, oldest point first. Empty, not null, for a session that carries no
   * route - it exists and simply has nothing to draw, the same distinction workoutSplits draws
   * between "no session" and "a session with nothing filled in". Null is reserved for the one
   * case sessionById already reserves it for: an id naming nothing this person owns.
   *
   * A detail-route reader only, following workoutSplits' own comment on why a per row fill
   * belongs there and never on the list - and a route is the strongest case of that rule in the
   * codebase, since every recorded point of a run is far more than a handful of splits. Route
   * points never reach an MCP tool response by default; that boundary lives in the tool
   * catalogue, not here.
   */
  workoutRoute(input: { sessionId: string }): RoutePoint[] | null {
    const session = this.sessionById(input)
    if (session === null) return null
    return readWorkoutRoute(this.#db, { session })
  }

  /**
   * A smoothed line over the daily series. Days with no row are absent from the input to
   * `trendOf` rather than zero, the same treatment `series` already gives a day with no data.
   */
  trend(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
  }): TrendPoint[] {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const { points } = this.series({
      metric: input.metric, agg: input.agg, from: input.from, to: input.to, source: input.source,
    })
    const byDate = new Map(points.map((point) => [point.localDate, point.value]))

    const days = daysBetween(input.from, input.to)
    const withGaps = Array.from({ length: days }, (_, i) => {
      const localDate = shiftLocalDate(input.from, i)
      return { localDate, value: byDate.get(localDate) ?? null }
    })

    return trendOf(withGaps)
  }

  /**
   * The (localDate, metric) pairs whose derived rows moved after `since`. See readChanges for
   * why the pairs are distinct rather than one per row, why a rebuild's whole-history answer is
   * correct rather than a bug, and why provider rows are in scope.
   */
  changes(input: {
    since: number
    limit?: number
    cursor?: string
  }): ChangesResult {
    requireFiniteNumber('since', input.since)
    if (input.limit !== undefined) requirePositiveInteger('limit', input.limit)
    return readChanges(this.#db, {
      personId: this.#personId,
      since: input.since,
      limit: input.limit,
      cursor: input.cursor,
    })
  }

  /**
   * The person's notes in a local date range, oldest first, optionally narrowed to those
   * containing a piece of text.
   *
   * Here rather than on NoteStore because of who calls it. NoteStore.listFor takes a person id as
   * a plain argument, so a tool body holding the store could name anybody in the household; this
   * class is the one place that binding is allowed to live, which is the same reason changes.ts
   * keeps its own reader unexported.
   *
   * `contains` is matched in memory rather than as a SQL LIKE. Notes are few and hand written,
   * the comparison is case insensitive on both sides, and a LIKE would need its own escaping for
   * the percent signs and underscores a person can perfectly well type into a note.
   */
  notes(input: {
    from: string
    to: string
    contains?: string
  }): StoredNote[] {
    requireRange(input.from, input.to)
    const rows = new NoteStore(this.#db).listFor(this.#personId, input.from, input.to)
    if (input.contains === undefined || input.contains === '') return rows
    const needle = input.contains.toLowerCase()
    return rows.filter((note) => note.body.toLowerCase().includes(needle))
  }

  /** The person's typed events in a local date range. Bound here for the reason `notes` gives. */
  events(input: {
    from: string
    to: string
  }): StoredEvent[] {
    requireRange(input.from, input.to)
    return new EventStore(this.#db).listFor(this.#personId, input.from, input.to)
  }

  /**
   * The bound person themselves: their id, display name, timezone, and the sources that have
   * reported for them. What `describe_person` answers, and the first call the M4a-2 tool surface
   * expects — source ids from here are what every other tool's `source` argument accepts.
   *
   * A missing person row is not an emptiness this throws past: construction binds `#personId`
   * once, and a session that outlives the account it was issued for is a bug elsewhere, not a
   * question this method can answer by degrading to nulls.
   *
   * `sources[].name` is namedSourcesOf's, the alias-then-default-then-display-name-then-id choice
   * every other surface makes, rather than a second copy of it living here. English, since an
   * agent has no reader's language to localise a known app's default into.
   */
  describe(input: { today?: string } = {}): DescribedPerson {
    const person = this.#db.select({
      id: people.id, displayName: people.displayName, timezone: people.timezone,
    }).from(people).where(eq(people.id, this.#personId)).get()
    if (person === undefined) throw new ConfigError(`no person named '${this.#personId}'`)

    // The shared read rather than a join of its own, because a known app's default name depends
    // on the person's other sources and a second copy of that rule here would drift from it.
    const rows = namedSourcesOf(this.#db, this.#personId, person.timezone)

    // Only when asked. The staleness read scans this person's daily rows, and describe() is the
    // cheap "who am I bound to" call every agent session opens with.
    const activity = input.today === undefined
      ? new Map<string, SourceActivity>()
      : new Map(readSourceActivity(this.#db, this.#personId, { today: input.today })
        .map((a) => [a.sourceId, a]))

    return {
      id: person.id,
      displayName: person.displayName,
      timezone: person.timezone,
      sources: rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        // null for a source with no daily rows as well as for a call that asked for none: an
        // agent is told "not known" rather than handed a guess either way.
        lastReportedDate: activity.get(row.id)?.lastReportedDate ?? null,
        status: activity.get(row.id)?.status ?? null,
      })),
    }
  }

  /**
   * Writes a projection of *this* person to `destPath`, for `sql_query` to run against.
   *
   * A method on the bound query rather than a free function taking a person id, for the same
   * reason every reader on this class is: `#personId` is a true private field, so there is no
   * expression a caller can write that produces another member's projection. The alternative -
   * handing `sql_query` the data directory and letting it open the database itself - would have
   * put the binding back in the caller's hands, which is the one thing this class exists to
   * prevent.
   */
  writeProjection(destPath: string): void {
    writeProjection(this.#db, this.#personId, destPath)
  }

  /**
   * The `daily` rows behind one metric and aggregate, in date order, for this person.
   *
   * A method rather than a statement inside `series`, because the fallback there has to ask the
   * same question twice with two different names, and two copies of a WHERE clause is how the
   * second one comes to disagree with the first about a source or a null value.
   *
   * A row with no value is not a measurement, and letting one through would put a hole in every
   * mean computed downstream. Nothing writes one today; this is the guard for later.
   */
  #rowsOf(metric: string, agg: string, from: string, to: string, source: string | undefined): DailyPoint[] {
    const rows = this.#db.select({
      localDate: daily.localDate,
      value: daily.value,
      coverage: daily.coverage,
      source: daily.source,
      sourceMix: daily.sourceMix,
      updatedAtMs: daily.updatedAtMs,
    }).from(daily).where(and(
      eq(daily.personId, this.#personId),
      eq(daily.metric, metric),
      eq(daily.agg, agg),
      source === undefined
        ? inArray(daily.source, [MERGED_SOURCE, PROVIDER_SOURCE])
        : eq(daily.source, source),
      gte(daily.localDate, from),
      lte(daily.localDate, to),
      isNotNull(daily.value),
    )).orderBy(asc(daily.localDate)).all() as Omit<DailyPoint, 'filled'>[]
    // Every row read here is the requested name's own: merged, provider, or a specific device,
    // never DEVICE_ROLLED_EQUIVALENT's stand-in. Only withFilledDays marks a row filled.
    return rows.map((row) => ({ ...row, filled: false }))
  }
}

/**
 * A series with the days only another name has, filled in from it and sorted back into order.
 *
 * A date the requested name already answers is never replaced: that name is the more specific
 * statement about the day, and a fallback that overwrote it would answer a question about what a
 * device computed with a number we computed ourselves. `rolledByDate` is read for the dates the
 * requested name is silent about and for nothing else, and every row keeps its own `source`, so
 * which name a day came from stays visible in the answer rather than being flattened by the fill.
 *
 * A row pulled in from `rolledByDate` is marked `filled: true` before it goes in. Its `source`
 * still says `merged` or `provider`, same as a genuine daily row, so `filled` is the only signal
 * that survives to tell a reader, an export or a language model that this number is the day's
 * intraday mean rather than the daily name's own measurement.
 */
function withFilledDays(
  points: readonly DailyPoint[],
  rolledByDate: ReadonlyMap<string, DailyPoint>,
): DailyPoint[] {
  if (rolledByDate.size === 0) return [...points]
  const answered = new Set(points.map((point) => point.localDate))
  const filled = [...points]
  for (const [localDate, point] of rolledByDate) {
    // `points` is already in range and ordered; `rolledByDate` was read over the same range, so
    // this adds no date the caller did not ask for.
    if (!answered.has(localDate)) filled.push({ ...point, filled: true })
  }
  return filled.sort((a, b) => (a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0))
}

export interface DescribedPerson {
  id: string
  displayName: string
  timezone: string
  sources: {
    id: string
    name: string
    kind: 'device' | 'app' | 'manual'
    /**
     * Both null unless `describe` was given a `today` to judge against. An agent reading a thin
     * series has no other way to learn that the device behind it stopped reporting, but the
     * staleness read costs a scan of this person's daily rows, so the caller asks for it.
     */
    lastReportedDate: string | null
    status: SourceStatus | null
  }[]
}

/**
 * One row per day, preferring the one we reconciled. Per row rather than per series, because a
 * single stray merged row must not hide an entire provider series, and a metric can gain a
 * merged row partway through its history the day a second device starts reporting it.
 */
function preferMerged(rows: readonly DailyPoint[]): DailyPoint[] {
  const byDate = new Map<string, DailyPoint>()
  for (const row of rows) {
    if (!byDate.has(row.localDate) || row.source === MERGED_SOURCE) byDate.set(row.localDate, row)
  }
  // Map iteration follows insertion, and the rows arrived ordered, so this stays oldest first.
  return [...byDate.values()]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The column holds ISO dates and every comparison against it is a string comparison, so an
 * unpadded '2026-8-1' does not just sort oddly, it silently excludes the whole month.
 */
export function requireDate(label: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new ConfigError(`${label} must be a YYYY-MM-DD local date, got '${value}'`)
  }
  // The shape alone accepts a thirteenth month and a thirtieth of February, and those diverge
  // rather than fail together: series compares them as strings and finds nothing, while the two
  // methods that step dates hand them to Date.parse and throw from three frames down. Round
  // tripping through the calendar is what refuses a date that cannot exist while keeping a real
  // leap day, and it makes all three methods refuse the same input the same way.
  const onCalendar = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(onCalendar.getTime()) || onCalendar.toISOString().slice(0, 10) !== value) {
    throw new ConfigError(`${label} is not a date on the calendar, got '${value}'`)
  }
}

function requireRange(from: string, to: string): void {
  requireDate('from', from)
  requireDate('to', to)
  if (from > to) throw new ConfigError(`from '${from}' is after to '${to}'`)
}

/**
 * windowDays: 0 used to compute a `from` after `to` and throw a ConfigError naming the two dates
 * instead of the argument that was actually wrong. Reaching zero or negative days back is not a
 * range problem, it is this argument, so this is what the message has to name.
 */
function requirePositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer, got ${value}`)
  }
}

/**
 * Separate from `requirePositiveInteger` because every caller of this one is optional, and that
 * function would refuse the absence as well as the mistake.
 *
 * `points` is where this was first needed: the HTTP surface validates it in `optionalPositiveInt`,
 * which is why an unvalidated tool caller went unnoticed. Left unvalidated, `points: NaN` reaches
 * `Math.max(2, NaN)` inside the downsampler, and `thinBand` then answers two points with a
 * `reduction` claiming `to: 2` - a confident wrong answer about somebody's health record, which is
 * the exact failure this class's rule about throwing rather than returning an emptiness exists to
 * prevent. `last` reaches this the same way, from a language model's tool arguments where "3" and
 * 3 are both plausible and only one is a number: a non-integer silently slicing nothing would
 * answer an empty list, the same emptiness this class exists not to return.
 */
function requireOptionalPositiveInteger(label: string, value: number | undefined): void {
  if (value === undefined) return
  requirePositiveInteger(label, value)
}

/**
 * `since` reaches PersonQuery from an HTTP query string and a language model's tool arguments,
 * neither of which the type system protects: a value that failed to parse to a number arrives
 * here as NaN rather than being caught on the way in.
 */
function requireFiniteNumber(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${label} must be a number, got ${value}`)
  }
}

/** The catalogue decides which aggregates a metric has. Summing heart rate is not an answer. */
function requireMetricAndAgg(metric: string, agg: string): void {
  const spec = metricSpec(metric)
  if (spec === undefined) throw new ConfigError(`no metric named '${metric}'`)
  if (!(spec.aggs as readonly string[]).includes(agg)) {
    throw new ConfigError(`metric '${metric}' has no '${agg}' aggregate, only ${spec.aggs.join(', ')}`)
  }
}

/**
 * `intraday` has no aggregate to validate against, since it reads samples directly rather than a
 * `daily` row, but the metric itself still needs the same refusal `requireMetricAndAgg` gives
 * every other reader: a typo left unvalidated answers with an empty result, indistinguishable
 * from "this person has no data".
 */
function requireMetric(metric: string): void {
  if (metricSpec(metric) === undefined) throw new ConfigError(`no metric named '${metric}'`)
}

/**
 * The two `daily.source` values that are not a source id at all. See rollup.ts for what each
 * means and why they are kept apart from one another.
 */
const DERIVED_SOURCES: readonly string[] = [MERGED_SOURCE, PROVIDER_SOURCE]

/**
 * The same refusal `requireMetric` gives a metric, for the one parameter that was still answering
 * a typo with an empty result: every read that takes a source narrowed to it with an equality
 * test, so an id nobody has matched no row and came back as 200 with nothing, indistinguishable
 * from "this person has no data" for the range asked for.
 *
 * Validated against `sources`, the registry of what this person actually has, rather than against
 * the distinct values present in the table being read: a device that reported nothing on the days
 * asked for is a real source with an empty answer, and refusing it would turn a true empty result
 * into an error. `alsoAllowed` carries the `daily` backed reads' two extra values, which name a
 * merge rather than a device and so appear in no registry.
 *
 * The listing is the person's own source ids, which a caller holding a PersonQuery is already
 * bound to by construction, so it discloses nothing the same caller cannot read from `/sources`.
 */
function requireSource(
  db: DbOrTx, personId: string, source: string | undefined, alsoAllowed: readonly string[],
): void {
  if (source === undefined) return
  // Ordered, so two identical requests cannot produce two different messages.
  const registered = db.select({ id: sources.id }).from(sources)
    .where(eq(sources.personId, personId)).orderBy(asc(sources.id)).all().map((row) => row.id)
  const known = [...registered, ...alsoAllowed]
  if (known.includes(source)) return
  throw new ConfigError(known.length === 0
    ? `no source named '${source}', and this person has no sources at all`
    : `no source named '${source}', only ${known.join(', ')}`)
}

/**
 * `sessions({ kind })` is typed as `'sleep' | 'exercise'`, but the type system only protects a
 * caller written in TypeScript. The two real consumers, an HTTP query string and a language
 * model's tool arguments, sit outside it, so a value the type forbids still has to be refused at
 * runtime rather than read as a kind that matches no row and called an empty answer.
 */
function requireSessionKind(kind: string): void {
  if (!(SESSION_KINDS as readonly string[]).includes(kind)) {
    throw new ConfigError(`kind must be one of ${SESSION_KINDS.join(', ')}, got '${kind}'`)
  }
}

/**
 * The provider's own vocabulary, not ours. A filter on a value Google never emits would answer
 * an empty list, which reads as "you have not run this month" rather than "that is not a word".
 */
function requireExerciseType(type: string | undefined): void {
  if (type === undefined) return
  if (!EXERCISE_TYPES.includes(type)) {
    throw new ConfigError(`no exercise type named '${type}'`)
  }
}

const DAY_MS = 86_400_000

/**
 * Inclusive, so a range from a date to itself is one day. Local dates carry no zone, so
 * parsing them as UTC midnights is exact and a daylight saving change never moves a date.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}
