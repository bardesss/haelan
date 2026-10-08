// Mirrors the wire shape of packages/core/src/query/periodFigure.ts, sleepPeriod.ts, activityPeriod.ts and recoveryPeriod.ts, after
// apps/server/src/routes/v1/period.ts rounds, re-judges and trims it, field for field rather than
// imported: @haelan/core's root export pulls in better-sqlite3 and drizzle, which have no business in
// a browser bundle (the precedent is useNightPage.ts).
import type { GlanceBaseline, GlanceStanding } from './useGlance.js'
import type { SessionRate } from '@haelan/core/exercise-category'

export type { GlanceBaseline, GlanceStanding }

export type PeriodRange = 'week' | 'month' | '3months' | 'year'
export type FigureDirection = 'up' | 'down' | 'neutral'
export type Judged = 'better' | 'worse' | null

export interface PeriodWindow { unit: 'week' | 'month' | 'quarter' | 'year', count: number, from: string, to: string }
export interface PeriodUsual extends GlanceBaseline { window: PeriodWindow, periods: number }
export interface DayCounts { within: number, above: number, below: number, unjudged: number }

export interface PeriodStripPoint {
  from: string
  to: string
  value: number | null
  band: GlanceBaseline | null
  standing: GlanceStanding | null
  judged: Judged
  days: number
}

export type PeriodReason = 'no-data' | 'too-few-days' | 'thin-usual' | null

export interface PeriodFigure {
  metric: string
  unit: string
  precision: number
  direction: FigureDirection
  /** What value and usual are an average of: a day, a week's worth, or the whole period's worth (the nap count). */
  per: 'day' | 'week' | 'period'
  value: number | null
  total: number | null
  days: number
  usual: PeriodUsual | null
  /** An additive figure's usual for its total, a whole period's worth; thin exactly when `usual` is. */
  usualTotal: PeriodUsual | null
  /** `total` against `usualTotal`; null while the period runs. */
  totalStanding: GlanceStanding | null
  totalJudged: Judged
  standing: GlanceStanding | null
  judged: Judged
  reason: PeriodReason
  counts: DayCounts
  /** Empty on every figure but the hero on 3months and year, and on every `more` figure. */
  daily: PeriodStripPoint[]
  /** Set on 3months and year only, and never on a `more` figure. */
  weekly: PeriodStripPoint[] | null
}

export interface PeriodHigh { localDate: string, value: number, good: boolean }
export interface PeriodChange { from: string, to: string, value: number | null, delta: number | null }
export interface PeriodHeader {
  range: PeriodRange
  from: string
  to: string
  today: string
  periodDays: number
  daysSoFar: number
  partial: boolean
}

export interface ZeroLine { minutes: number, source: 'baseline' | 'target' }

export interface SleepListRow {
  localDate: string
  sourceId: string
  asleepMinutes: number | null
  bedtimeMinutes: number | null
  waketimeMinutes: number | null
  standing: GlanceStanding | null
  judged: Judged
  good: boolean
  /** Filed under a Saturday or Sunday morning: core's rule, the schedule's weekend colour. */
  weekend: boolean
}

/** A Monday-to-Sunday week of the balance, clipped to the period: its nights' signed minutes added up. */
export interface BalanceWeek { from: string, to: string, value: number | null }
/** A calendar month of the nights list ("2026-08"), its nights with a time asleep and their mean. */
export interface NightMonth { month: string, nights: number, asleepMinutes: number | null }

export interface ScheduleSide { bedtimeMinutes: number, waketimeMinutes: number, nights: number }
export interface ScheduleSides { weekday: ScheduleSide | null, weekend: ScheduleSide | null }

export interface SleepPeriodData {
  period: PeriodHeader
  hero: PeriodFigure
  high: PeriodHigh | null
  previous: PeriodChange
  yearEarlier: PeriodChange
  figures: PeriodFigure[]
  stages: {
    deep: PeriodFigure | null
    light: PeriodFigure | null
    rem: PeriodFigure | null
    awake: PeriodFigure | null
    shares: { deep: number, light: number, rem: number, awake: number } | null
  }
  schedule: {
    bedtime: PeriodFigure | null
    waketime: PeriodFigure | null
    variability: PeriodFigure | null
    sides: ScheduleSides
  }
  balance: { zeroLine: ZeroLine, values: (number | null)[], total: number, weekly: BalanceWeek[] } | null
  mornings: PeriodFigure[]
  more: PeriodFigure[]
  nights: SleepListRow[]
  /** Newest first: the nights list's month headers on 3 months and a year. */
  months: NightMonth[]
}

export interface WorkoutListRow {
  id: string
  sourceId: string
  localDate: string
  startMs: number
  endMs: number
  type: string | null
  durationSeconds: number | null
  distanceMeters: number | null
  caloriesKcal: number | null
  averageHeartRateBpm: number | null
  paceSecondsPerKm: number | null
  elevationGainMeters: number | null
  /** Some figure on the row came from the phone's samples; absent from an older payload. */
  filled?: boolean
  excluded: boolean
  /** The workout's rate as its category reads it, rounded (core's sessionRateOf); null for none,
   *  absent from a capture older than it. */
  rate?: SessionRate | null
}

/** A calendar month of the workouts list ("2026-08"): its counted workouts and their time. */
export interface WorkoutMonth { month: string, count: number, seconds: number }

export interface TypeTotal {
  type: string | null
  count: number
  seconds: number
  distanceMeters: number | null
  /** Fractional: each earlier block is scaled to the period's length. */
  usualCount: PeriodUsual | null
  standing: GlanceStanding | null
  /** More of a type than usual is the better side. */
  judged: Judged
}

export interface Vo2Trend {
  metric: string
  latest: number
  latestDate: string
  earlier: number | null
  earlierDate: string | null
  trend: 'rising' | 'falling' | 'steady' | null
}

export interface ActivityPeriodData {
  period: PeriodHeader
  /** Steps, per day. */
  hero: PeriodFigure
  high: PeriodHigh | null
  previous: PeriodChange
  yearEarlier: PeriodChange
  workoutCount: number
  figures: PeriodFigure[]
  intensity: { light: PeriodFigure | null, moderate: PeriodFigure | null, vigorous: PeriodFigure | null }
  zoneMinutes: { fatBurn: PeriodFigure | null, cardio: PeriodFigure | null, peak: PeriodFigure | null }
  /** `hard` is the vigorous and peak zones summed a day ("intensief of piek"). */
  heartRateZones: {
    light: PeriodFigure | null, moderate: PeriodFigure | null, vigorous: PeriodFigure | null, peak: PeriodFigure | null
    hard: PeriodFigure | null
  }
  /** Each day's highest heart rate, averaged over the period. */
  maxHeartRate: PeriodFigure | null
  /** Newest first, every workout of the period, excluded ones included. */
  workouts: WorkoutListRow[]
  /** Newest first, a month each that has a counted workout: the list's month headers on 3 months and a year. */
  workoutMonths: WorkoutMonth[]
  types: TypeTotal[]
  cardioLoad: PeriodFigure | null
  vo2max: Vo2Trend | null
  more: PeriodFigure[]
}

export type RecoveryBand = 'low' | 'below' | 'usual' | 'above' | 'high'
export type RecoveryInputKey = 'hrv' | 'restingHeartRate' | 'sleep' | 'respiratoryRate'

/** One input of a scored day: its weight, its points to a tenth and its contribution to a thousandth. */
export interface RecoveryInput { key: RecoveryInputKey, weight: number, points: number, contribution: number }
/** One scored day, for the tap panel. Sent on week and month only; `[]` on 3 months and a year. */
export interface RecoveryDay { localDate: string, score: number, band: RecoveryBand, inputs: RecoveryInput[] }

export type HrvSide = 'below' | 'within' | 'above'
export type HrvDeviationDay =
  | { localDate: string, measured: true, rolling: number, band: { low: number, high: number }, side: HrvSide }
  | { localDate: string, measured: false, reason: 'thin-week' | 'thin-baseline' | 'flat-baseline' }
export interface HrvDeviationRun {
  side: 'below' | 'above'
  days: number
  capped: boolean
  since: string
  sideNights: number
  weekReadings: number
  filledDays: number
}

/** A run of the HRV stretch inside the period: its first and last measured days there. */
export interface HrvStretchSpan { from: string, to: string, side: 'below' | 'above' }
/** A Monday-to-Sunday week of the stretch, clipped to the period: its last measured day, null with none. */
export interface HrvStretchWeek { from: string, to: string, point: HrvDeviationDay | null }
export interface RecoveryStretch {
  /** Empty on 3 months and a year. */
  days: HrvDeviationDay[]
  /** Set on 3 months and a year only. */
  weeks: HrvStretchWeek[] | null
  runs: HrvStretchSpan[]
  run: HrvDeviationRun | null
}
export interface RecoveryMethod {
  weights: Record<RecoveryInputKey, number>
  usualBand: { low: number, high: number }
  baselineDays: number
  stretch: { weekDays: number, minReadings: number, band: number, minRun: number, lookbackDays: number }
}

export interface RecoveryPeriodData {
  period: PeriodHeader
  hero: PeriodFigure
  high: PeriodHigh | null
  low: PeriodHigh | null
  previous: PeriodChange
  yearEarlier: PeriodChange
  carriedBy: RecoveryInputKey | null
  /** Resting heart rate, HRV, breathing rate, those with days. */
  figures: PeriodFigure[]
  /** Null when no day of the period is measured. */
  stretch: RecoveryStretch | null
  /** Every scored day, oldest first; `[]` on 3 months and a year. */
  days: RecoveryDay[]
  method: RecoveryMethod
}
