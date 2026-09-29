// Mirrors the wire shape of packages/core/src/query/periodFigure.ts and sleepPeriod.ts, after
// apps/server/src/routes/v1/period.ts rounds, re-judges and trims it, field for field rather than
// imported: @haelan/core's root export pulls in better-sqlite3 and drizzle, which have no business in
// a browser bundle (the precedent is useNightPage.ts).
import type { GlanceBaseline, GlanceStanding } from './useGlance.js'

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
  per: 'day' | 'week'
  value: number | null
  total: number | null
  days: number
  usual: PeriodUsual | null
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
}

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
  balance: { zeroLine: ZeroLine, values: (number | null)[], total: number } | null
  mornings: PeriodFigure[]
  more: PeriodFigure[]
  nights: SleepListRow[]
}
