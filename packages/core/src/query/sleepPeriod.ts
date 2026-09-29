// The Sleep overview (M10b): a week, month, three months or year of nights, every figure judged
// against periods of its own length. Computed on read from existing rows, one read per metric.
import type { PersonQuery } from './personQuery.ts'
import type { FigureDirection, GlanceStanding, Judged } from './glance.ts'
import { oneNightPerDate } from '../api/nights.ts'
import { recoveryIndexSeries, sleepWeekSeries } from '../api/recoveryIndex.ts'
import { balanceOf, balanceZeroLine } from '../api/sleepBalance.ts'
import type { ZeroLine } from '../api/sleepBalance.ts'
import type { Baseline } from './baseline.ts'
import type { SleepSummary } from '../api/sleepSummary.ts'
import { readRecoveryInput } from './recoveryInput.ts'
import { summaryOf } from './nightPage.ts'
import { minDate, periodBounds } from './periodBounds.ts'
import type { PeriodRange } from './periodBounds.ts'
import { highOf } from './periodFigure.ts'
import type { PeriodChange, PeriodFigure, PeriodHeader, PeriodHigh, PeriodStripPoint } from './periodFigure.ts'
import { catalogueRead, orNull, periodChanges, periodHeader, readSpan, shown, valuesFigure } from './periodRead.ts'

export interface SleepPeriodInput {
  range: PeriodRange, anchor: string, today: string, source?: string
  sleepTargetMinutes: number, sleepUseBaseline: boolean
}
export interface SleepListRow {
  localDate: string, sourceId: string
  asleepMinutes: number | null, bedtimeMinutes: number | null, waketimeMinutes: number | null
  standing: GlanceStanding | null, judged: Judged, good: boolean
}
export interface ScheduleSide { bedtimeMinutes: number, waketimeMinutes: number, nights: number }
export interface ScheduleSides { weekday: ScheduleSide | null, weekend: ScheduleSide | null }
export interface SleepPeriod {
  period: PeriodHeader
  /** Time asleep, per night. */
  hero: PeriodFigure
  /** The longest night. */
  high: PeriodHigh | null
  /** The calendar period before. */
  previous: PeriodChange
  /** The same period a year earlier. */
  yearEarlier: PeriodChange
  /** Efficiency, deep, REM, bedtime, in that order, only those with days. */
  figures: PeriodFigure[]
  stages: {
    deep: PeriodFigure | null, light: PeriodFigure | null, rem: PeriodFigure | null, awake: PeriodFigure | null
    shares: { deep: number, light: number, rem: number, awake: number } | null
  }
  schedule: { bedtime: PeriodFigure | null, waketime: PeriodFigure | null, variability: PeriodFigure | null, sides: ScheduleSides }
  balance: { zeroLine: ZeroLine, values: (number | null)[], total: number } | null
  /** Recovery index, resting heart rate, HRV, breathing, SpO2, skin temperature, those with days. */
  mornings: PeriodFigure[]
  /** Light, awake, in bed, wake time, latency, awakenings, after-wake, naps, those with days. */
  more: PeriodFigure[]
  /** Newest first, every night of the period that has a time asleep. */
  nights: SleepListRow[]
}

const SIDE_MIN_NIGHTS = 2

// Answers: the mean bedtime and wake time of the nights ending on the given mornings, null below two nights.
function sideOf(nights: readonly { bed: number, wake: number }[]): ScheduleSide | null {
  if (nights.length < SIDE_MIN_NIGHTS) return null
  const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  return { bedtimeMinutes: mean(nights.map((n) => n.bed)), waketimeMinutes: mean(nights.map((n) => n.wake)), nights: nights.length }
}

// Answers: weekday against weekend nights. A night is filed under the morning it ended (metrics.ts),
// so Saturday and Sunday mornings are the weekend: the nights of Friday and Saturday.
function sidesOf(bedtime: readonly PeriodStripPoint[], waketime: readonly PeriodStripPoint[]): ScheduleSides {
  const wakeBy = new Map(waketime.map((p) => [p.from, p.value]))
  const weekday: { bed: number, wake: number }[] = []
  const weekend: { bed: number, wake: number }[] = []
  for (const p of bedtime) {
    const wake = wakeBy.get(p.from)
    if (p.value === null || wake === null || wake === undefined) continue
    const day = new Date(`${p.from}T00:00:00Z`).getUTCDay()
    ;(day === 0 || day === 6 ? weekend : weekday).push({ bed: p.value, wake })
  }
  return { weekday: sideOf(weekday), weekend: sideOf(weekend) }
}

export function readSleepPeriod(q: PersonQuery, input: SleepPeriodInput): SleepPeriod {
  const { range, anchor, source } = input
  const bounds = periodBounds(range, anchor)
  // A night is finished once it has a date, so today's night counts.
  const lastDay = minDate(input.today, bounds.to)
  const span = readSpan(range, bounds)
  const base = { range, anchor, bounds, span, lastDay, source }
  const read = (metric: string, agg: string) => catalogueRead(q, { ...base, metric, agg })
  const figure = (metric: string, agg: string) => read(metric, agg).figure

  // Figures over values computed here rather than read, each banded in memory as `baselines` would.
  const derived = (
    metric: string, o: { unit: string, precision: number, direction: FigureDirection }, values: Map<string, number>,
    dailyBands?: ReadonlyMap<string, Baseline | null>,
  ) => valuesFigure({ metric, ...o, range, anchor, bounds, lastDay, values, dailyBands, additive: false })

  const asleep = read('sleep_asleep_minutes', 'sum')
  const hero = asleep.figure
  const bed = read('sleep_bedtime_minutes', 'last')
  const waketime = figure('sleep_waketime_minutes', 'last')
  const deep = figure('sleep_deep_minutes', 'sum')
  const light = figure('sleep_light_minutes', 'sum')
  const rem = figure('sleep_rem_minutes', 'sum')
  const awake = figure('sleep_awake_minutes', 'sum')
  const bedtime = bed.figure

  const dayValues = (values: ReadonlyMap<string, number>) => [...values].map(([localDate, value]) => ({ localDate, value }))
  const { consistency } = sleepWeekSeries(dayValues(asleep.series.values), dayValues(bed.series.values), { from: span.from, to: lastDay })
  const variability = derived('sleep_bedtime_variability', { unit: 'minutes', precision: 0, direction: 'down' },
    new Map(consistency.map((d) => [d.localDate, d.value])))

  // The index is scored from merged rows, whatever source the page is narrowed to, as the glance scores it.
  const scores = recoveryIndexSeries(readRecoveryInput(q, { from: span.from, to: lastDay }).input, { from: span.from, to: lastDay })
  // The index keeps its period usual, made of period means of the index, but no day of it is banded:
  // it already is a distance from the person's own baselines, and a baseline of that would be a
  // baseline of a baseline (readRecovery, glance.ts). So its daily standing and verdict stay null.
  const recovery = derived('recovery_index', { unit: 'score', precision: 0, direction: 'up' },
    new Map([...scores].flatMap(([date, day]) => (day.enough ? [[date, day.score] as const] : []))), new Map())

  // The three figures only the provider's summary holds, from one read of the nights and their sessions.
  const nightsInSpan = oneNightPerDate(q.sleepNights({ from: span.from, to: lastDay, sourceId: source }))
  const attrsById = new Map(q.sessions({ kind: 'sleep', from: span.from, to: lastDay, sourceId: source }).map((s) => [s.id, s.attrs]))
  const summaries = nightsInSpan.map((n) => [n.localDate, summaryOf(n, attrsById)] as const)
  const summaryValues = (key: keyof SleepSummary) =>
    new Map(summaries.flatMap(([date, s]) => (s === null || s[key] === null ? [] : [[date, s[key]] as const])))

  const zeroLine = balanceZeroLine(asleep.series.bands.get(lastDay) ?? null, input.sleepUseBaseline, input.sleepTargetMinutes)
  const balanced = balanceOf(hero.daily.map((d) => d.value), zeroLine.minutes)

  const stageValues = [deep.value, light.value, rem.value, awake.value]
  const stageSum = stageValues.reduce<number>((s, v) => s + (v ?? 0), 0)
  const shares = stageValues.every((v) => v !== null) && stageSum > 0
    ? { deep: deep.value! / stageSum, light: light.value! / stageSum, rem: rem.value! / stageSum, awake: awake.value! / stageSum }
    : null

  const nightOn = new Map(nightsInSpan.map((n) => [n.localDate, n.sourceId]))
  const valueOn = (daily: readonly PeriodStripPoint[]) => {
    const by = new Map(daily.map((p) => [p.from, p.value]))
    return (date: string) => by.get(date) ?? null
  }
  const bedOn = valueOn(bedtime.daily)
  const wakeOn = valueOn(waketime.daily)
  const nights: SleepListRow[] = hero.daily.filter((p) => p.value !== null).reverse().map((p) => ({
    localDate: p.from,
    // A night with a time asleep but no session behind it is named by the source asked for, or the merge.
    sourceId: nightOn.get(p.from) ?? source ?? 'merged',
    asleepMinutes: p.value,
    bedtimeMinutes: bedOn(p.from),
    waketimeMinutes: wakeOn(p.from),
    standing: p.standing,
    judged: p.judged,
    good: p.judged === 'better',
  }))

  return {
    period: periodHeader(range, bounds, input.today, lastDay),
    hero,
    high: highOf(hero.daily),
    ...periodChanges(asleep.series.values, range, anchor, bounds, hero.value, lastDay),
    figures: [figure('sleep_efficiency', 'last'), deep, rem, bedtime].filter(shown),
    stages: { deep: orNull(deep), light: orNull(light), rem: orNull(rem), awake: orNull(awake), shares },
    schedule: {
      bedtime: orNull(bedtime), waketime: orNull(waketime), variability: orNull(variability),
      sides: sidesOf(bedtime.daily, waketime.daily),
    },
    balance: hero.days === 0 ? null : { zeroLine, values: balanced.values, total: balanced.total },
    mornings: [
      recovery,
      figure('resting_heart_rate', 'last'),
      figure('daily_hrv', 'last'),
      figure('sleep_respiratory_rate', 'last'),
      figure('daily_spo2', 'last'),
      figure('sleep_temperature', 'last'),
    ].filter(shown),
    more: [
      light, awake, figure('sleep_in_bed_minutes', 'sum'), waketime,
      derived('sleep_latency_minutes', { unit: 'minutes', precision: 0, direction: 'down' }, summaryValues('minutesToFallAsleep')),
      derived('sleep_awakenings', { unit: 'count', precision: 0, direction: 'down' }, summaryValues('awakenings')),
      derived('sleep_after_wake_minutes', { unit: 'minutes', precision: 0, direction: 'neutral' }, summaryValues('minutesAfterWakeUp')),
      figure('sleep_nap_minutes', 'sum'),
    ].filter(shown),
    nights,
  }
}
