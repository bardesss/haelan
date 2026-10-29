import { z } from 'zod'
import { LOCAL_DATE, requireToolRange } from '../dates.ts'
import { metricSpec } from '@haelan/core/metrics'
import type { MetricSpec } from '@haelan/core/metrics'
import { BASELINE_WINDOW_DAYS, baselineWindow, coverageIsMeaningful, INSIGHT_MIN_COVERAGE, ZONE_FORMULA_BASIS } from '@haelan/core'
import type { DailyPoint } from '@haelan/core'
import type { Tool } from '../contract.ts'
import { budgetFor, defineTool, summaryOf, DEFAULT_DAILY_POINTS, REDUCTION, SUMMARY } from '../contract.ts'

/**
 * The `source` every daily tool takes, described once and shared, because all five accept exactly
 * the same three kinds of value and a description that drifted between them would be worse than
 * none.
 *
 * `merged` and `provider` are why this argument is `source` on these five and not `sourceId`:
 * neither is a device id, and neither appears in any source registry — they name who reconciled a
 * day rather than what recorded it (`packages/core/src/derive/rollup.ts` declares both, and
 * `requireSource` lets them through for the `daily` backed reads only). The intraday, sleep and
 * workout tools take the same argument name but not these two values, and say so themselves.
 */
export const DAILY_SOURCE = z.string().optional().describe(
  'A source id from describe_person to read one device on its own, or `merged` for only the days '
  + 'this app reconciled itself, or `provider` for only the days Google had already reconciled. '
  + 'Omitted answers the day rather than one device: the merged row where there is one, the '
  + 'provider row where there is not.',
)

// Shared by query_series and get_daily, the two tools that answer a raw daily reading rather than
// a computed statistic (a baseline, a trend, a period comparison): those average or smooth across
// many days, and which of the contributing days were filled is a different, harder question this
// catalogue does not try to answer yet. A point-level reading has no such excuse.
const FILLED_DESCRIPTION =
  'True when the daily name itself had no row this date and this value is that day\'s intraday '
  + 'average standing in for it, not the device\'s own daily summary. Say so in words when reporting '
  + 'a filled reading; do not state it as a measurement.'

// Shared by query_series and get_daily for the reason FILLED_DESCRIPTION is: a point-level reading
// carries what it rests on, and an agent has no caption to read it from. `zone_formula` is the
// only value today (packages/core/src/derive/rollup.ts's ZONE_FORMULA_BASIS), written on the heart
// rate zone minutes the derive estimated for a phone-only day and on the cardio load built on them.
const BASIS_DESCRIPTION =
  'What this value rests on when it is not what a device recorded. `zone_formula` means estimated '
  + 'from the person\'s age and that day\'s resting heart rate, not measured: heart rate zone '
  + 'minutes sorted by the formula, or a cardio load computed from them. Say so in words when '
  + 'reporting it. '
  + 'Null for a recorded value.'

// Shared by get_baselines, compare_periods and trend, the three tools that blend many days into
// one statistic - a boolean per day cannot ride along through that fold the way it does on
// query_series and get_daily, but a count can, and does.
const FILLED_DAYS_DESCRIPTION =
  'How many of the days behind this answer were filled in from an intraday average rather than '
  + 'the device\'s own daily summary, out of how many. State a nonzero count in words before '
  + 'treating this answer as built entirely from measured days.'

const FILLED_DAYS = z.object({
  filled: z.number(),
  of: z.number(),
}).describe(FILLED_DAYS_DESCRIPTION)

function filledCountOf(points: readonly DailyPoint[]): { filled: number, of: number } {
  return { filled: points.filter((point) => point.filled).length, of: points.length }
}

// The blended tools' counterpart to BASIS_DESCRIPTION, for the reason FILLED_DAYS exists: a mean,
// a band or a smoothed line has no point left to carry a `basis` on, so the count of days that
// rested on the zone formula travels beside it instead.
const FORMULA_DAYS = z.object({
  formula: z.number(),
  of: z.number(),
}).describe(
  'How many of the days behind this statistic were estimated from age and resting heart rate '
  + '(`basis: zone_formula`) rather than measured, out of how many. Say so when it is not zero.',
)

// One sentence every blended tool's description ends with, so a model reads it beside the field.
const FORMULA_DAYS_SENTENCE =
  ' Heart rate zone minutes and cardio load can rest on days estimated from age and resting heart '
  + 'rate rather than measured; the formula days count says how many, and a finding should say so.'

function formulaCountOf(points: readonly DailyPoint[]): { formula: number, of: number } {
  return { formula: points.filter((point) => point.basis === ZONE_FORMULA_BASIS).length, of: points.length }
}

/**
 * `points` narrowed to the ones `PersonQuery.baseline()` actually averages, by the identical
 * filter it applies itself (packages/core/src/query/personQuery.ts).
 *
 * Needed because a coverage judged metric (steps, heart rate, ...) drops a barely observed day
 * before averaging, so counting filled over the raw fetch overstates `of` against `baseline.n` -
 * a real defect the scoped re-review caught (seeded steps gave `n: 4` but `of: 6`). Mirroring the
 * filter here, through the same exported `coverageIsMeaningful`/`INSIGHT_MIN_COVERAGE` baseline()
 * itself uses rather than a second invented threshold, keeps `filledDays.of` equal to `n` instead
 * of merely close to it.
 */
function baselineContributingPoints(points: readonly DailyPoint[], metric: string): readonly DailyPoint[] {
  const judgeCoverage = coverageIsMeaningful(metric)
  return points.filter((point) => !(judgeCoverage && point.coverage !== null && point.coverage < INSIGHT_MIN_COVERAGE))
}

export const querySeries = defineTool({
  name: 'query_series',
  description:
    'A daily metric over a date range, oldest first. Returns at most a few hundred points: a '
    + 'longer range is downsampled and `reduction` says so, so read `summary` for the true extremes '
    + 'rather than assuming the points are every day. Report findings with their coverage, and as '
    + 'association rather than cause. Some readings are marked `filled`; see that field before '
    + 'calling a filled day a measurement. A reading whose `basis` is `zone_formula` was estimated '
    + 'from age and resting heart rate, not measured; say so when reporting it.',
  inputSchema: {
    metric: z.string(),
    agg: z.string(),
    from: LOCAL_DATE.describe('YYYY-MM-DD, inclusive'),
    to: LOCAL_DATE.describe('YYYY-MM-DD, inclusive'),
    points: z.number().optional(),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    points: z.array(z.object({
      localDate: z.string(), value: z.number(),
      coverage: z.number().nullable(), source: z.string(),
      filled: z.boolean().describe(FILLED_DESCRIPTION),
      basis: z.string().nullable().describe(BASIS_DESCRIPTION),
    })),
    reduction: REDUCTION,
    summary: SUMMARY,
  },
  run: (q, args) => {
    requireToolRange(args.from, args.to)
    const result = q.series({
      metric: args.metric, agg: args.agg, from: args.from, to: args.to,
      points: budgetFor(args.points, DEFAULT_DAILY_POINTS), source: args.source,
    })
    return {
      points: result.points.map((p) => ({
        localDate: p.localDate, value: p.value, coverage: p.coverage, source: p.source,
        filled: p.filled, basis: p.basis,
      })),
      reduction: result.reduction,
      summary: summaryOf(result.points.map((p) => p.value)),
    }
  },
})

/**
 * The aggregate get_daily reaches for when a metric's own reading is asked for and `agg` was not
 * named.
 *
 * `MetricSpec.aggs` is ordered for the range-chart display (min, mean, max, then the rest), not by
 * which one answers "what happened this day" — the app's own dashboard already answers that
 * question for heart_rate, hrv and spo2 by asking `query_series` for 'mean', never for the 'min'
 * their `aggs` lists first (Dashboard.tsx's mean-HR tile, and the mean series Health.tsx and
 * Recovery.tsx build spo2/hrv cards from). Every other metric's first entry already is the one
 * natural single-day reading: the metric's only aggregate, or 'last' for an episodic reading like
 * weight or body_fat, which is why `aggs[0]` is trusted everywhere else. This overrides it only for
 * the three metrics where the list is a display order rather than a priority order.
 */
export function defaultAggFor(spec: MetricSpec): string {
  return spec.aggs.includes('min') && spec.aggs.includes('mean') ? 'mean' : spec.aggs[0]!
}

export const getDaily = defineTool({
  name: 'get_daily',
  description:
    'Several metrics for a single day, one reading each, so an agent asking "what happened on '
    + 'this date" does not have to call query_series once per metric itself. Omit `agg` and each '
    + 'metric answers with its own natural aggregate — the reading each metric\'s own card shows '
    + 'elsewhere on this surface — named in that reading\'s own `agg` field, so metrics as different '
    + 'as heart rate and steps can be asked for together in one call. Name an `agg` and it applies '
    + 'to every metric in the list alike; a metric that does not support it is refused outright, '
    + 'naming that metric and that aggregate, rather than silently dropped from the answer. A metric '
    + 'with no row that day answers null rather than being left out, so a caller can tell "zero" '
    + 'from "not measured" — the same distinction a missing daily row always carries elsewhere on '
    + 'this surface. Some readings are marked `filled`; see that field before calling a filled day '
    + 'a measurement. A reading whose `basis` is `zone_formula` was estimated from age and resting '
    + 'heart rate, not measured; say so when reporting it.',
  inputSchema: {
    localDate: LOCAL_DATE.describe('YYYY-MM-DD'),
    metrics: z.array(z.string()).min(1),
    agg: z.string().optional().describe(
      'Applies to every metric in `metrics` alike. Omitted, each metric uses its own default '
      + 'aggregate instead (see each reading\'s own `agg`); named, a metric that does not support '
      + 'it throws rather than being dropped from the answer.',
    ),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    localDate: z.string(),
    readings: z.array(z.object({
      metric: z.string(),
      agg: z.string(),
      value: z.number().nullable(),
      coverage: z.number().nullable(),
      source: z.string().nullable(),
      // Null alongside value/coverage/source for the same reason those three are: nothing was
      // measured that day, so whether it would have been filled is not a question with an answer.
      filled: z.boolean().nullable().describe(FILLED_DESCRIPTION),
      // Null with no row as well as for a recorded one: nothing was estimated that day either.
      basis: z.string().nullable().describe(BASIS_DESCRIPTION),
    })),
  },
  run: (q, args) => ({
    localDate: args.localDate,
    readings: args.metrics.map((metric) => {
      const spec = metricSpec(metric)
      // spec undefined means `metric` is not in the catalogue at all; any string handed to `agg`
      // here is moot, because q.series's own requireMetricAndAgg rejects the unknown metric before
      // it ever looks at the aggregate, and this value never reaches a caller.
      const agg = args.agg ?? (spec === undefined ? '' : defaultAggFor(spec))
      const point = q.series({
        metric, agg, from: args.localDate, to: args.localDate, source: args.source,
      }).points[0]
      return {
        metric,
        agg,
        value: point?.value ?? null,
        coverage: point?.coverage ?? null,
        source: point?.source ?? null,
        filled: point?.filled ?? null,
        basis: point?.basis ?? null,
      }
    }),
  }),
})

export const getBaselines = defineTool({
  name: 'get_baselines',
  description:
    'A person\'s own center and spread for a metric, computed from the `windowDays` before `on` '
    + '(default 60), never including the day itself. `thin` says whether there was enough history to '
    + 'stand on — treat a thin baseline as low confidence rather than as evidence of nothing. Report '
    + 'a reading against it as a distance in units of spread, and as association rather than cause.'
    + FORMULA_DAYS_SENTENCE,
  inputSchema: {
    metric: z.string(),
    agg: z.string(),
    on: LOCAL_DATE.describe('YYYY-MM-DD, the baseline is computed from the days before this one'),
    windowDays: z.number().optional(),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    baseline: z.object({
      center: z.number(),
      spread: z.number(),
      n: z.number(),
      thin: z.boolean(),
    }).nullable(),
    filledDays: FILLED_DAYS,
    formulaDays: FORMULA_DAYS,
  },
  run: (q, args) => {
    // baseline() answers center, spread and n, none of which carries `filled`, so its own window
    // (the same rule baselineWindow names, which baseline() calls too) is reopened here through a
    // fresh series() call, then narrowed through baselineContributingPoints to the same days
    // baseline() itself averaged, so filledDays.of equals baseline.n exactly rather than
    // overcounting a day a coverage gate excluded.
    const windowDays = args.windowDays ?? BASELINE_WINDOW_DAYS
    const { from, to } = baselineWindow(args.on, windowDays)
    const { points } = q.series({ metric: args.metric, agg: args.agg, from, to, source: args.source })
    const contributing = baselineContributingPoints(points, args.metric)
    return {
      baseline: q.baseline({
        metric: args.metric, agg: args.agg, on: args.on, windowDays: args.windowDays, source: args.source,
      }),
      filledDays: filledCountOf(contributing),
      formulaDays: formulaCountOf(contributing),
    }
  },
})

const DATE_RANGE = z.object({ from: z.string(), to: z.string() }).nullable()

export const comparePeriods = defineTool({
  name: 'compare_periods',
  description:
    'A date range\'s mean against the equal-length period immediately before it, with the delta and '
    + 'the coverage behind each side. Answers nulls and `suppressed: true` with a `reason` when '
    + 'either period has too few days or too little coverage to stand on — read a suppressed answer '
    + 'as "not enough data", never as "no change". Report a finding with `delta` and the two coverage '
    + 'fields, and as association between the periods rather than a claim about cause.'
    + FORMULA_DAYS_SENTENCE,
  inputSchema: {
    metric: z.string(),
    agg: z.string(),
    from: LOCAL_DATE.describe('YYYY-MM-DD, inclusive, the current period'),
    to: LOCAL_DATE.describe('YYYY-MM-DD, inclusive, the current period'),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    current: z.number().nullable(),
    previous: z.number().nullable(),
    delta: z.number().nullable(),
    currentDays: z.number(),
    previousDays: z.number(),
    periodDays: z.number(),
    currentCoverage: z.number().nullable(),
    previousCoverage: z.number().nullable(),
    currentRange: DATE_RANGE,
    previousRange: DATE_RANGE,
    suppressed: z.boolean(),
    reason: z.string().nullable(),
    currentFilledDays: FILLED_DAYS,
    previousFilledDays: FILLED_DAYS,
    currentFormulaDays: FORMULA_DAYS,
    previousFormulaDays: FORMULA_DAYS,
  },
  run: (q, args) => {
    requireToolRange(args.from, args.to)
    const insight = q.comparePeriods({
      metric: args.metric, agg: args.agg, from: args.from, to: args.to, source: args.source,
    })
    // comparePeriods() always fills currentRange/previousRange in from the arithmetic it already
    // did, even when suppressed, so both windows are reopened straight off the response rather
    // than redoing "the period before this one" math a second time - the same reasoning
    // apps/server/src/routes/v1/series.ts's /insights route already applies.
    const currentWindow = q.series({
      metric: args.metric, agg: args.agg, from: insight.currentRange!.from, to: insight.currentRange!.to, source: args.source,
    })
    const previousWindow = q.series({
      metric: args.metric, agg: args.agg, from: insight.previousRange!.from, to: insight.previousRange!.to, source: args.source,
    })
    return {
      ...insight,
      currentFilledDays: filledCountOf(currentWindow.points),
      previousFilledDays: filledCountOf(previousWindow.points),
      currentFormulaDays: formulaCountOf(currentWindow.points),
      previousFormulaDays: formulaCountOf(previousWindow.points),
    }
  },
})

export const trend = defineTool({
  name: 'trend',
  description:
    'A smoothed line over the daily series for one metric over a date range, oldest first — an '
    + 'exponentially weighted moving average, not a stored value. Short of three contributing days '
    + 'it answers an empty list rather than a noisy line. Read `summary` for the true range rather '
    + 'than assuming the last point is representative. Report a shape (rising, falling, flat) with '
    + 'its coverage, and as association rather than cause.'
    + FORMULA_DAYS_SENTENCE,
  inputSchema: {
    metric: z.string(),
    agg: z.string(),
    from: LOCAL_DATE.describe('YYYY-MM-DD, inclusive'),
    to: LOCAL_DATE.describe('YYYY-MM-DD, inclusive'),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    points: z.array(z.object({ localDate: z.string(), value: z.number() })),
    summary: SUMMARY,
    filledDays: FILLED_DAYS,
    formulaDays: FORMULA_DAYS,
  },
  run: (q, args) => {
    requireToolRange(args.from, args.to)
    const points = q.trend({
      metric: args.metric, agg: args.agg, from: args.from, to: args.to, source: args.source,
    })
    // trend smooths the same series() this reads again, over the same from/to: no window math to
    // redo here, only the read of `filled` the smoothed points themselves do not carry.
    const raw = q.series({
      metric: args.metric, agg: args.agg, from: args.from, to: args.to, source: args.source,
    })
    return {
      points, summary: summaryOf(points.map((p) => p.value)),
      filledDays: filledCountOf(raw.points), formulaDays: formulaCountOf(raw.points),
    }
  },
})

export const seriesTools: Tool[] = [querySeries, getDaily, getBaselines, comparePeriods, trend]
