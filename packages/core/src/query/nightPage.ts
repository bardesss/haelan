// The night page (M10a): one night, every figure on it judged against its own usual range, beside
// the morning after it and the day before it. Computed on read from existing rows, like the glance
// it borrows its figures from, so nothing is stored and no install rebuilds on upgrade.
import { shiftLocalDate } from '../derive/localDay.ts'
import type { PersonQuery } from './personQuery.ts'
import { activeMinutesFigure, contextFor, dailyFigure, readRecovery } from './glance.ts'
import type { GlanceContext, GlanceNav, GlanceRecovery } from './glance.ts'
import { baselineWindow, BASELINE_MIN_DAYS } from './baseline.ts'
import { oneNightPerDate } from '../api/nights.ts'
import { recoveryWindowStart, sleepWeekSeries } from '../api/recoveryIndex.ts'
import { isMainSleep, sleepSummary } from '../api/sleepSummary.ts'
import type { SleepSummary } from '../api/sleepSummary.ts'
import { balanceOf, balanceZeroLine } from '../api/sleepBalance.ts'
import type { ZeroLine } from '../api/sleepBalance.ts'
import { figureFromValues, pageFigureOf } from './pageFigure.ts'
import type { PageFigure } from './pageFigure.ts'
import { nightTrace } from './nightTraces.ts'
import type { NightTrace } from './nightTraces.ts'
import type { Night } from './sleepNights.ts'
import type { WorkoutSession } from './sessions.ts'

export interface NightPageInput {
  localDate: string, today: string, nowMs: number, nameOf: (sourceId: string) => string
  sleepTargetMinutes: number, sleepUseBaseline: boolean
}

export interface NightPage {
  localDate: string
  sourceId: string
  night: Night
  nav: GlanceNav
  figures: {
    asleep: PageFigure, efficiency: PageFigure, deep: PageFigure, rem: PageFigure, light: PageFigure,
    awake: PageFigure, inBed: PageFigure, bedtime: PageFigure, waketime: PageFigure,
    napCount: PageFigure, napMinutes: PageFigure,
    minutesToFallAsleep: PageFigure, awakenings: PageFigure, minutesAfterWakeUp: PageFigure,
    bedtimeVariability: PageFigure
  }
  stagePercent: { deep: number | null, light: number | null, rem: number | null }
  balance: { zeroLine: ZeroLine, nights: { localDate: string, difference: number | null }[], total: number }
  traces: { heartRate: NightTrace, hrv: NightTrace, spo2: NightTrace }
  morning: {
    /** The index and its band; the two figures below are the same readings, judged. */
    recovery: GlanceRecovery
    restingHeartRate: PageFigure
    hrv: PageFigure
    breathing: PageFigure
    spo2: PageFigure
    skinTemperature: PageFigure
    skinTemperatureDeviation: number | null
  }
  day: { localDate: string, steps: PageFigure, activeMinutes: PageFigure, workouts: WorkoutSession[] }
}

// Answers: which sleep session speaks for a night's provider summary - the main sleep, else the first.
export function summaryOf(night: Night, attrsById: ReadonlyMap<string, unknown>): SleepSummary | null {
  const attrs = night.sessionIds.map((id) => attrsById.get(id)).filter((a) => a !== undefined)
  const main = attrs.find((a) => isMainSleep(a) === true) ?? attrs[0]
  return main === undefined ? null : sleepSummary(main)
}

// Answers: the three figures only the provider's summary holds, each against the nights before this one.
function summaryFigures(q: PersonQuery, night: Night, history: readonly Night[], window: { from: string }) {
  const attrsById = new Map(q.sessions({ kind: 'sleep', from: window.from, to: night.localDate }).map((s) => [s.id, s.attrs]))
  const own = summaryOf(night, attrsById)
  const earlier = history.map((n) => summaryOf(n, attrsById)).filter((s) => s !== null)
  const figure = (metric: string, key: keyof SleepSummary, unit: string, direction: 'down' | 'neutral') => figureFromValues({
    metric, unit, precision: 0, direction, value: own?.[key] ?? null, minN: BASELINE_MIN_DAYS,
    history: earlier.flatMap((s) => (s[key] === null ? [] : [s[key]])),
  })
  return {
    minutesToFallAsleep: figure('sleep_latency_minutes', 'minutesToFallAsleep', 'minutes', 'down'),
    awakenings: figure('sleep_awakenings', 'awakenings', 'count', 'down'),
    minutesAfterWakeUp: figure('sleep_after_wake_minutes', 'minutesAfterWakeUp', 'minutes', 'neutral'),
  }
}

// Answers: how much bedtime moved over the week ending on this night, against the same statistic on earlier nights.
function bedtimeVariability(q: PersonQuery, localDate: string, window: { from: string }): PageFigure {
  const read = (metric: string, agg: string) => q.series({ metric, agg, from: recoveryWindowStart(window.from), to: localDate })
    .points.map((p) => ({ localDate: p.localDate, value: p.value }))
  const { consistency } = sleepWeekSeries(read('sleep_asleep_minutes', 'sum'), read('sleep_bedtime_minutes', 'last'), { from: window.from, to: localDate })
  return figureFromValues({
    metric: 'sleep_bedtime_variability', unit: 'minutes', precision: 0, direction: 'down', minN: BASELINE_MIN_DAYS,
    value: consistency.find((d) => d.localDate === localDate)?.value ?? null,
    history: consistency.filter((d) => d.localDate < localDate).map((d) => d.value),
  })
}

// Answers: the day this night belongs with. A night filed under D was slept after day D-1, so D-1 is its day.
function dayBefore(q: PersonQuery, localDate: string, input: NightPageInput): NightPage['day'] {
  const day = shiftLocalDate(localDate, -1)
  const dayCtx = contextFor(q, { today: day, nowMs: input.nowMs, nameOf: input.nameOf, finished: true })
  return {
    localDate: day,
    steps: pageFigureOf(dailyFigure(dayCtx, { metric: 'steps', agg: 'sum', on: day, partial: false, asOfMs: null }), false),
    activeMinutes: pageFigureOf(activeMinutesFigure(dayCtx), false),
    workouts: q.sessions({ kind: 'exercise', from: day, to: day }),
  }
}

// Answers: the nearest nights either side, by the time-asleep rows a night leaves; never past today.
function navOf(q: PersonQuery, localDate: string, today: string): GlanceNav {
  const nights = (from: string, to: string) => q.series({ metric: 'sleep_asleep_minutes', agg: 'sum', from, to }).points
  const before = nights(shiftLocalDate(localDate, -3650), shiftLocalDate(localDate, -1))
  const after = localDate === today ? [] : nights(shiftLocalDate(localDate, 1), today)
  return { previous: before.at(-1)?.localDate ?? null, next: after[0]?.localDate ?? null }
}

// Answers: a stage's share of time asleep, in percent; null where either side is missing or nothing was slept.
function shareOf(stage: number | null, asleep: number | null): number | null {
  return stage === null || asleep === null || asleep === 0 ? null : (stage / asleep) * 100
}

export function readNightPage(q: PersonQuery, input: NightPageInput): NightPage | null {
  const { localDate } = input
  const night = oneNightPerDate(q.sleepNights({ from: localDate, to: localDate }))[0]
  if (night === undefined) return null
  const ctx: GlanceContext = contextFor(q, { today: localDate, nowMs: input.nowMs, nameOf: input.nameOf, finished: localDate < input.today })
  // Every daily figure is judged as the glance judges last night's: a whole night, current to its end.
  const figure = (metric: string, agg: string) =>
    pageFigureOf(dailyFigure(ctx, { metric, agg, on: localDate, partial: false, asOfMs: night.endMs }), true)
  const window = baselineWindow(localDate)
  const history = oneNightPerDate(q.sleepNights(window))

  const asleep = figure('sleep_asleep_minutes', 'sum')
  const deep = figure('sleep_deep_minutes', 'sum')
  const light = figure('sleep_light_minutes', 'sum')
  const rem = figure('sleep_rem_minutes', 'sum')
  const skinTemperature = figure('sleep_temperature', 'last')

  const zeroLine = balanceZeroLine(asleep.baseline, input.sleepUseBaseline, input.sleepTargetMinutes)
  const strip = asleep.strip ?? []
  const balanced = balanceOf(strip.map((d) => d.value), zeroLine.minutes)
  const skinBaseline = skinTemperature.baseline
  const recovery = readRecovery(ctx)

  return {
    localDate,
    sourceId: night.sourceId,
    night,
    nav: navOf(q, localDate, input.today),
    figures: {
      asleep,
      efficiency: figure('sleep_efficiency', 'last'),
      deep,
      rem,
      light,
      awake: figure('sleep_awake_minutes', 'sum'),
      inBed: figure('sleep_in_bed_minutes', 'sum'),
      bedtime: figure('sleep_bedtime_minutes', 'last'),
      waketime: figure('sleep_waketime_minutes', 'last'),
      napCount: figure('sleep_nap_count', 'count'),
      napMinutes: figure('sleep_nap_minutes', 'sum'),
      ...summaryFigures(q, night, history, window),
      bedtimeVariability: bedtimeVariability(q, localDate, window),
    },
    stagePercent: { deep: shareOf(deep.value, asleep.value), light: shareOf(light.value, asleep.value), rem: shareOf(rem.value, asleep.value) },
    balance: {
      zeroLine,
      nights: strip.map((d, i) => ({ localDate: d.localDate, difference: balanced.values[i] ?? null })),
      total: balanced.total,
    },
    traces: {
      heartRate: nightTrace(q, 'heart_rate', night, history),
      hrv: nightTrace(q, 'hrv', night, history),
      spo2: nightTrace(q, 'spo2', night, history),
    },
    morning: {
      recovery,
      // The glance's figures carry no direction or verdict of their own; as page figures they are
      // judged like every other figure here, a higher resting heart rate worse, a lower HRV worse.
      restingHeartRate: pageFigureOf(recovery.restingHeartRate, true),
      hrv: pageFigureOf(recovery.hrv, true),
      breathing: figure('sleep_respiratory_rate', 'last'),
      spo2: figure('daily_spo2', 'last'),
      skinTemperature,
      skinTemperatureDeviation: skinTemperature.value === null || skinBaseline === null || skinBaseline.thin
        ? null : skinTemperature.value - skinBaseline.center,
    },
    day: dayBefore(q, localDate, input),
  }
}
