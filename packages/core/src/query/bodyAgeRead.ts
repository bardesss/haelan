import { and, eq, inArray, min } from 'drizzle-orm'
import {
  BODY_AGE_FACTORS, BODY_AGE_TOTAL_CAP, BODY_AGE_TOTAL_CAP_BASIS, BODY_AGE_WINDOW_DAYS, GOMPERTZ_SLOPE, MIN_FACTOR_DAYS,
  MIN_NIGHTS_PER_BLOCK, MIN_SLEEP_BLOCKS, SLEEP_BLOCK_DAYS, VO2_LOOKBACK_DAYS,
  bodyAgeHistory,
} from '../api/bodyAge.ts'
import type { BodyAgeFactorKey, BodyAgeHistory, BodyAgeInput, CapBasis } from '../api/bodyAge.ts'
import type { DbOrTx } from '../db/open.ts'
import { daily, people } from '../db/schema/index.ts'
import { VO2_METRICS } from './activityPeriod.ts'
import { PersonQuery } from './personQuery.ts'
import type { SeriesResult } from './personQuery.ts'
import { categoryOf } from './workoutDerived.ts'

/**
 * Gathers a person's archive into body age: `bodyAgeHistory` over every day they have, to `today`.
 *
 * Birth date and sex come from `people`, as `readBanister` reads them. The span starts at the
 * person's earliest `daily` row among the metrics below, so the history is as long as the archive.
 *
 * No `points` argument, anywhere in this file. A point budget is a display concern for a chart;
 * a body age that moved with a chart's own budget would not be measuring anything.
 */

/** What the figure rests on, for a page that has to cite it. */
export interface BodyAgeMethod {
  windowDays: number
  vo2LookbackDays: number
  minFactorDays: number
  gompertzSlope: number
  totalCap: number
  /** Which rule set `totalCap`, as each factor's `capBasis` says for its own cap. */
  totalCapBasis: CapBasis
  /** Sleep regularity's own rule in place of `minFactorDays`: `minBlocks` 7-day blocks of `minNightsPerBlock` nights. */
  sleep: { blockDays: number, minBlocks: number, minNightsPerBlock: number }
  factors: Array<{ key: BodyAgeFactorKey, unit: string, cap: number, capBasis: CapBasis, citation: string }>
}

export interface BodyAgeRead extends BodyAgeHistory {
  method: BodyAgeMethod
}

const FIXED_METRICS = ['resting_heart_rate', 'daily_hrv', 'sleep_bedtime_minutes', 'active_minutes_light', 'active_minutes_moderate', 'active_minutes_vigorous']

const BODY_AGE_METHOD: BodyAgeMethod = {
  windowDays: BODY_AGE_WINDOW_DAYS,
  vo2LookbackDays: VO2_LOOKBACK_DAYS,
  minFactorDays: MIN_FACTOR_DAYS,
  gompertzSlope: GOMPERTZ_SLOPE,
  totalCap: BODY_AGE_TOTAL_CAP,
  totalCapBasis: BODY_AGE_TOTAL_CAP_BASIS,
  sleep: { blockDays: SLEEP_BLOCK_DAYS, minBlocks: MIN_SLEEP_BLOCKS, minNightsPerBlock: MIN_NIGHTS_PER_BLOCK },
  factors: BODY_AGE_FACTORS.map(({ key, unit, cap, capBasis, citation }) => ({ key, unit, cap, capBasis, citation })),
}

/**
 * The input `bodyAgeHistory` is given, and the first day it covers. Exported so a probe reads
 * exactly what production reads. A person with no daily rows at all gets `from` = `today` and
 * empty series, which scores to an empty history rather than an error.
 */
export function readBodyAgeInput(db: DbOrTx, personId: string, input: { today: string }): { input: BodyAgeInput, from: string } {
  const person = db.select().from(people).where(eq(people.id, personId)).get()
  const earliest = db.select({ first: min(daily.localDate) }).from(daily)
    .where(and(eq(daily.personId, personId), inArray(daily.metric, [...VO2_METRICS, ...FIXED_METRICS])))
    .get()?.first ?? null
  const from = earliest === null || earliest > input.today ? input.today : earliest

  const q = new PersonQuery(db, personId)
  const fetch = (metric: string, agg: 'last' | 'sum'): SeriesResult => q.series({ metric, agg, from, to: input.today })
  const toDayValues = (result: SeriesResult) => result.points.map((p) => ({ localDate: p.localDate, value: p.value }))

  // The three VO2 metrics are one quantity from different sources, merged into one daily series so
  // a device that switched from one to another still has a recent reading. On a day two of them
  // have, the one earlier in VO2_METRICS' order of preference is kept.
  const vo2ByDate = new Map<string, number>()
  for (const metric of VO2_METRICS) {
    for (const p of fetch(metric, 'last').points) if (!vo2ByDate.has(p.localDate)) vo2ByDate.set(p.localDate, p.value)
  }
  const vo2Max = [...vo2ByDate]
    .map(([localDate, value]) => ({ localDate, value }))
    .sort((a, b) => a.localDate.localeCompare(b.localDate))

  // Vigorous minutes count double (the activity factor expects that). The source writes no row for a
  // level with no minutes, so a date is present when any level has a row: a light-only day is a worn
  // day with zero, and leaving it out averaged over the active days alone (a quarter of worn days in
  // the household archive, about a third added to the weekly figure).
  const activity = new Map<string, number>()
  for (const [metric, weight] of [['active_minutes_light', 0], ['active_minutes_moderate', 1], ['active_minutes_vigorous', 2]] as const) {
    for (const p of fetch(metric, 'sum').points) activity.set(p.localDate, (activity.get(p.localDate) ?? 0) + weight * p.value)
  }
  const activityMinutes = [...activity]
    .map(([localDate, value]) => ({ localDate, value }))
    .sort((a, b) => a.localDate.localeCompare(b.localDate))

  const strengthSessionDates = q.sessions({ kind: 'exercise', from, to: input.today })
    .filter((s) => categoryOf(s) === 'strength')
    .map((s) => s.localDate)

  return {
    from,
    input: {
      birthDate: person?.birthDate ?? null,
      sex: person?.sex ?? null,
      vo2Max,
      restingHeartRate: toDayValues(fetch('resting_heart_rate', 'last')),
      hrv: toDayValues(fetch('daily_hrv', 'last')),
      activityMinutes,
      bedtimeMinutes: toDayValues(fetch('sleep_bedtime_minutes', 'last')),
      strengthSessionDates,
    },
  }
}

export function readBodyAge(db: DbOrTx, personId: string, input: { today: string }): BodyAgeRead {
  const read = readBodyAgeInput(db, personId, input)
  return { ...bodyAgeHistory(read.input, input.today), method: BODY_AGE_METHOD }
}
