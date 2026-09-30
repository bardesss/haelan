// The night page (M10a): one night, every figure on it judged against its own usual range, beside
// the morning after it and the day before it. Computed on read from existing rows, like the glance
// it borrows its figures from, so nothing is stored and no install rebuilds on upgrade.
import { shiftLocalDate } from '../derive/localDay.ts'
import type { PersonQuery } from './personQuery.ts'
import { activeMinutesFigure, contextFor, dailyFigure, readRecovery } from './glance.ts'
import type { GlanceContext, GlanceNav, GlanceRecovery, GlanceStanding } from './glance.ts'
import { baselineWindow, BASELINE_MIN_DAYS } from './baseline.ts'
import { oneNightPerDate } from '../api/nights.ts'
import { recoveryWindowStart, sleepWeekSeries } from '../api/recoveryIndex.ts'
import { isMainSleep, sleepSummary } from '../api/sleepSummary.ts'
import type { SleepSummary } from '../api/sleepSummary.ts'
import { balanceOf, balanceZeroLine } from '../api/sleepBalance.ts'
import type { ZeroLine } from '../api/sleepBalance.ts'
import { figureFromValues, pageFigureOf } from './pageFigure.ts'
import type { PageFigure } from './pageFigure.ts'
import { nightTrace, nightTraceHistory } from './nightTraces.ts'
import type { NightTrace, NightTraceStat } from './nightTraces.ts'
import { stageTimingOf } from './stageTiming.ts'
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
  /**
   * How long after falling asleep the first deep and REM sleep began, and how many REM episodes;
   * with the instants the first deep and REM segment began. Null on a classic night.
   */
  stageTiming: { firstDeep: PageFigure, firstRem: PageFigure, cycles: PageFigure, firstDeepAtMs: number | null, firstRemAtMs: number | null }
  /** Of the morning's judged figures, how many sat outside their usual. */
  morningSummary: MorningSummary
  morning: {
    /** The index and its band; the two figures below are the same readings, judged. */
    recovery: GlanceRecovery
    restingHeartRate: PageFigure
    hrv: PageFigure
    breathing: PageFigure
    spo2: PageFigure
    skinTemperature: PageFigure
    skinTemperatureDeviation: number | null
    /** How far the heart rate fell below the morning's resting rate while asleep, in percent of the resting rate. */
    heartRateDip: PageFigure
  }
  day: { localDate: string, steps: PageFigure, activeMinutes: PageFigure, workouts: WorkoutSession[] }
}

export interface MorningSummary { outside: number, of: number }

/** Counts the judged morning figures (standing !== null) and those outside (above/below). */
export function morningSummaryOf(figures: readonly { standing: GlanceStanding | null }[]): MorningSummary {
  const judged = figures.filter((f) => f.standing !== null)
  return { outside: judged.filter((f) => f.standing !== 'within').length, of: judged.length }
}

/**
 * The summary over a page's morning figures. The one list of what counts, shared with the route,
 * which calls it again over the rounded figures. The recovery index is left out: readRecovery
 * never judges it (it is already a distance from the person's own baselines), so it could never count.
 */
export function morningSummaryOfMorning(m: Pick<NightPage['morning'], 'restingHeartRate' | 'hrv' | 'breathing' | 'spo2' | 'skinTemperature' | 'heartRateDip'>): MorningSummary {
  return morningSummaryOf([m.restingHeartRate, m.hrv, m.breathing, m.spo2, m.skinTemperature, m.heartRateDip])
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

// Answers: when the first deep and REM sleep came and how many REM episodes there were, each against the nights before.
function stageTimingFigures(night: Night, history: readonly Night[]): NightPage['stageTiming'] {
  const own = stageTimingOf(night.segments)
  const earlier = history.map((n) => stageTimingOf(n.segments))
  const figure = (metric: string, key: 'firstDeepMinutes' | 'firstRemMinutes' | 'cycles', unit: string) => figureFromValues({
    metric, unit, precision: 0, direction: 'neutral', value: own[key], minN: BASELINE_MIN_DAYS,
    history: earlier.flatMap((t) => (t[key] === null ? [] : [t[key]])),
  })
  return {
    firstDeep: figure('sleep_first_deep_minutes', 'firstDeepMinutes', 'minutes'),
    firstRem: figure('sleep_first_rem_minutes', 'firstRemMinutes', 'minutes'),
    cycles: figure('sleep_cycles', 'cycles', 'count'),
    firstDeepAtMs: own.firstDeepAtMs,
    firstRemAtMs: own.firstRemAtMs,
  }
}

const dipPercent = (resting: number, lowest: number) => ((resting - lowest) / resting) * 100

// Answers: how far the heart rate fell below the morning's resting rate while asleep, as a percent
// of that resting rate ((resting - lowest) / resting x 100), against the same on the nights before. The lowest readings are the heart-rate trace's own history
// stats, aligned with `history`, so no night's window is read a second time here.
function heartRateDip(
  q: PersonQuery, resting: number | null, lowest: number | null,
  history: readonly Night[], historyStats: readonly NightTraceStat[], window: { from: string, to: string },
): PageFigure {
  const restingOn = new Map(q.series({ metric: 'resting_heart_rate', agg: 'last', from: window.from, to: window.to })
    .points.map((p) => [p.localDate, p.value]))
  const earlier = historyStats.flatMap((stat, i) => {
    const r = restingOn.get(history[i]!.localDate)
    return r === undefined || r <= 0 || stat.lowest === null ? [] : [dipPercent(r, stat.lowest.value)]
  })
  return figureFromValues({
    metric: 'sleep_heart_rate_dip', unit: 'percent', precision: 0, direction: 'up', minN: BASELINE_MIN_DAYS,
    value: resting === null || resting <= 0 || lowest === null ? null : dipPercent(resting, lowest), history: earlier,
  })
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
    workouts: q.sessions({ kind: 'exercise', from: day, to: day, fill: true }),
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
  const heartRateHistory = nightTraceHistory(q, 'heart_rate', history)
  const heartRate = nightTrace(q, 'heart_rate', night, history, heartRateHistory)
  const restingHeartRate = pageFigureOf(recovery.restingHeartRate, true)
  const hrv = pageFigureOf(recovery.hrv, true)
  const breathing = figure('sleep_respiratory_rate', 'last')
  const spo2 = figure('daily_spo2', 'last')
  // Only a resting heart rate recorded on the night's own date, as each history night's is; the
  // glance's fallback to the day before would measure tonight against a different morning.
  const restingTonight = recovery.restingHeartRate.asOfDate === localDate ? restingHeartRate.value : null
  const dip = heartRateDip(q, restingTonight, heartRate.stat.lowest?.value ?? null, history, heartRateHistory, window)

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
      heartRate,
      hrv: nightTrace(q, 'hrv', night, history),
      spo2: nightTrace(q, 'spo2', night, history),
    },
    stageTiming: stageTimingFigures(night, history),
    morningSummary: morningSummaryOfMorning({ restingHeartRate, hrv, breathing, spo2, skinTemperature, heartRateDip: dip }),
    morning: {
      recovery,
      // The glance's figures carry no direction or verdict of their own; as page figures they are
      // judged like every other figure here, a higher resting heart rate worse, a lower HRV worse.
      restingHeartRate,
      hrv,
      breathing,
      spo2,
      skinTemperature,
      skinTemperatureDeviation: skinTemperature.value === null || skinBaseline === null || skinBaseline.thin
        ? null : skinTemperature.value - skinBaseline.center,
      heartRateDip: dip,
    },
    day: dayBefore(q, localDate, input),
  }
}
