import type { FastifyInstance } from 'fastify'
import { balanceOf, balanceWeeks, countsOf, highOf, judge, nightMonths, standingOf, vo2TrendOf } from '@haelan/core'
import type { ActivityPeriod, PeriodChange, PeriodFigure, PeriodRange, PeriodStripPoint, SleepPeriod } from '@haelan/core'
import {
  personAndToday, personIdOf, personQueryOf, requireString, roundBandTo, roundMetricValue, roundTo, roundToOrNull, sendHashed,
  standingAfterRounding,
} from './shared.ts'

interface PersonParams { personId: string }
interface PeriodQuery { range?: string, anchor?: string, source?: string }

/** One strip point at `precision`, re-judged against its own rounded band. */
function roundPoint(precision: number, direction: PeriodFigure['direction'], point: PeriodStripPoint): PeriodStripPoint {
  const value = roundToOrNull(precision, point.value)
  const band = roundBandTo(precision, point.band)
  const standing = standingAfterRounding(point.standing, value, band)
  return { ...point, value, band, standing, judged: judge(standing, direction) }
}

/**
 * A period figure at its own precision, with every verdict taken again from the rounded numbers,
 * the rule roundPageFigure follows: the value, total and usual, then each daily and weekly point
 * against its own rounded band. The counts are recomputed from the rounded daily points last, so
 * "12 within" always matches the dots the page draws. `reason` stays: rounding never turns a
 * non-null band null, so it cannot change why a figure is or is not judged.
 */
export function roundPeriodFigure(f: PeriodFigure): PeriodFigure {
  const { precision, direction } = f
  const value = roundToOrNull(precision, f.value)
  const usual = roundBandTo(precision, f.usual)
  const standing = standingAfterRounding(f.standing, value, usual)
  const daily = f.daily.map((p) => roundPoint(precision, direction, p))
  return {
    ...f,
    value,
    total: roundToOrNull(precision, f.total),
    usual,
    standing,
    judged: judge(standing, direction),
    daily,
    weekly: f.weekly === null ? null : f.weekly.map((p) => roundPoint(precision, direction, p)),
    counts: countsOf(daily),
  }
}

const roundOrNull = (f: PeriodFigure | null) => (f === null ? null : roundPeriodFigure(f))

/** The change against an earlier period, taken again from the two rounded numbers, as /insights sends its delta. */
function roundChange(change: PeriodChange, hero: PeriodFigure): PeriodChange {
  const value = roundToOrNull(hero.precision, change.value)
  const delta = hero.value === null || value === null ? null : roundToOrNull(hero.precision, hero.value - value)
  return { ...change, value, delta }
}

/**
 * The Sleep overview at the wire's precision. Every figure goes through roundPeriodFigure; the
 * numbers taken from the hero (the longest night, the changes, the balance and its weeks, the nights
 * list and its months) are taken again from the rounded hero, so none of them can disagree with a
 * dot the page draws. A month's mean is rounded as the hero is; a night's weekend flag is a date's,
 * which rounding cannot touch.
 */
export function roundSleepPeriod(p: SleepPeriod): SleepPeriod {
  const hero = roundPeriodFigure(p.hero)
  const bedtime = roundOrNull(p.schedule.bedtime)
  const waketime = roundOrNull(p.schedule.waketime)
  const valueOn = (f: PeriodFigure | null) => {
    const by = new Map((f?.daily ?? []).map((d) => [d.from, d]))
    return (date: string) => by.get(date) ?? null
  }
  const heroOn = valueOn(hero)
  const bedOn = valueOn(bedtime)
  const wakeOn = valueOn(waketime)
  const { shares } = p.stages
  const side = (s: SleepPeriod['schedule']['sides']['weekday']) =>
    (s === null ? null : { ...s, bedtimeMinutes: roundTo(0, s.bedtimeMinutes), waketimeMinutes: roundTo(0, s.waketimeMinutes) })
  let balance: SleepPeriod['balance'] = null
  if (p.balance !== null) {
    const zeroMinutes = roundMetricValue('sleep_asleep_minutes', p.balance.zeroLine.minutes)
    const balanced = balanceOf(hero.daily.map((d) => d.value), zeroMinutes)
    balance = {
      zeroLine: { ...p.balance.zeroLine, minutes: zeroMinutes }, values: balanced.values, total: balanced.total,
      weekly: balanceWeeks(hero.daily.map((d) => d.from), balanced.values),
    }
  }
  return {
    ...p,
    hero,
    high: highOf(hero.daily),
    previous: roundChange(p.previous, hero),
    yearEarlier: roundChange(p.yearEarlier, hero),
    figures: p.figures.map(roundPeriodFigure),
    stages: {
      deep: roundOrNull(p.stages.deep), light: roundOrNull(p.stages.light),
      rem: roundOrNull(p.stages.rem), awake: roundOrNull(p.stages.awake),
      shares: shares === null ? null
        : { deep: roundTo(3, shares.deep), light: roundTo(3, shares.light), rem: roundTo(3, shares.rem), awake: roundTo(3, shares.awake) },
    },
    schedule: {
      bedtime, waketime, variability: roundOrNull(p.schedule.variability),
      sides: { weekday: side(p.schedule.sides.weekday), weekend: side(p.schedule.sides.weekend) },
    },
    balance,
    mornings: p.mornings.map(roundPeriodFigure),
    more: p.more.map(roundPeriodFigure),
    nights: p.nights.map((row) => {
      const point = heroOn(row.localDate)
      const judged = point?.judged ?? null
      return {
        ...row,
        asleepMinutes: point?.value ?? null,
        bedtimeMinutes: bedOn(row.localDate)?.value ?? null,
        waketimeMinutes: wakeOn(row.localDate)?.value ?? null,
        standing: point?.standing ?? null,
        judged,
        good: judged === 'better',
      }
    }),
    months: nightMonths(hero.daily).map((m) => ({ ...m, asleepMinutes: roundToOrNull(hero.precision, m.asleepMinutes) })),
  }
}

/**
 * The Activity overview at the wire's precision, by the Sleep rule for its figures. Workouts are
 * whole seconds, metres, kcal and bpm. A type's usual count is fractional (each earlier block is
 * scaled to the period's length), so it is sent to a tenth and the type's standing is taken again
 * from that rounded band. VO2 max goes to the tenth its readings carry, with its trend recomputed
 * from the two numbers sent.
 */
export function roundActivityPeriod(p: ActivityPeriod): ActivityPeriod {
  const hero = roundPeriodFigure(p.hero)
  const { vo2max } = p
  return {
    ...p,
    hero,
    high: highOf(hero.daily),
    previous: roundChange(p.previous, hero),
    yearEarlier: roundChange(p.yearEarlier, hero),
    figures: p.figures.map(roundPeriodFigure),
    intensity: {
      light: roundOrNull(p.intensity.light), moderate: roundOrNull(p.intensity.moderate), vigorous: roundOrNull(p.intensity.vigorous),
    },
    zoneMinutes: {
      fatBurn: roundOrNull(p.zoneMinutes.fatBurn), cardio: roundOrNull(p.zoneMinutes.cardio), peak: roundOrNull(p.zoneMinutes.peak),
    },
    heartRateZones: {
      light: roundOrNull(p.heartRateZones.light), moderate: roundOrNull(p.heartRateZones.moderate),
      vigorous: roundOrNull(p.heartRateZones.vigorous), peak: roundOrNull(p.heartRateZones.peak),
    },
    workouts: p.workouts.map((w) => ({
      ...w,
      durationSeconds: roundToOrNull(0, w.durationSeconds),
      distanceMeters: roundToOrNull(0, w.distanceMeters),
      caloriesKcal: roundToOrNull(0, w.caloriesKcal),
      averageHeartRateBpm: roundToOrNull(0, w.averageHeartRateBpm),
    })),
    types: p.types.map((t) => {
      const usualCount = roundBandTo(1, t.usualCount)
      return {
        ...t,
        seconds: roundTo(0, t.seconds),
        distanceMeters: roundToOrNull(0, t.distanceMeters),
        usualCount,
        standing: standingOf(t.count, usualCount, p.period.partial),
      }
    }),
    cardioLoad: roundOrNull(p.cardioLoad),
    vo2max: vo2max === null ? null : (() => {
      const latest = roundTo(1, vo2max.latest)
      const earlier = roundToOrNull(1, vo2max.earlier)
      return { ...vo2max, latest, earlier, trend: vo2TrendOf(latest, earlier) }
    })(),
    more: p.more.map(roundPeriodFigure),
  }
}

const isFigure = (value: unknown): value is PeriodFigure =>
  typeof value === 'object' && value !== null && 'daily' in value && 'counts' in value && 'precision' in value

/** Applies `trim` to every figure inside `value`, however deep (a section of figures, an array of them), leaving everything else alone. */
function trimFigures(value: unknown, trim: (f: PeriodFigure) => PeriodFigure): unknown {
  if (isFigure(value)) return trim(value)
  if (Array.isArray(value)) return value.map((v) => trimFigures(v, trim))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimFigures(v, trim)]))
  }
  return value
}

/**
 * Drops the strips the page never draws, after rounding and recounting, so the body stays near
 * 150 kB at a month and 250 kB at a year rather than the megabyte a year of daily points in every
 * figure came to on the demo (M10b Task 6). A `more` figure is drawn as a bar and its counts, on
 * every range, so it sends no strip at all. On three months and a year every other figure is drawn
 * by its weeks, so it keeps `weekly` and sends no days. The hero keeps its days on every range:
 * the balance, the steps heatmap and the tap panel all read them. `counts` were taken from the
 * rounded days before this runs, so they still describe the days a figure no longer sends.
 */
export function trimForWire<P extends SleepPeriod | ActivityPeriod>(payload: P, range: PeriodRange): P {
  const byWeek = range === '3months' || range === 'year'
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'hero') out[key] = value
    else if (key === 'more') out[key] = trimFigures(value, (f) => ({ ...f, daily: [], weekly: null }))
    else out[key] = byWeek ? trimFigures(value, (f) => ({ ...f, daily: [] })) : value
  }
  return out as P
}

/**
 * The range, anchor and source every period read takes. Only their presence is checked here: core's
 * sleepPeriod and activityPeriod refuse an unknown range (`day` included), a malformed anchor and a
 * period that starts after today, each with a ConfigError (400). `all` (or no source) is the merge;
 * any other value is passed through, and core refuses an unknown or derived source name with a 400,
 * as /insights does.
 */
function periodQuery(query: PeriodQuery): { range: PeriodRange, anchor: string, source: string | undefined } {
  // Narrowed by cast only: core refuses a range outside PERIOD_RANGES before it reads anything.
  const range = requireString(query.range, 'range') as PeriodRange
  const anchor = requireString(query.anchor, 'anchor')
  const source = query.source === undefined || query.source === 'all' ? undefined : query.source
  return { range, anchor, source }
}

/**
 * The two overview reads (M10b): a week, month, three months or year of Sleep or Activity. Hashed
 * rather than stamped, as the detail pages are: each body mixes sessions and daily rows.
 */
export function registerPeriodRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: PeriodQuery }>('/p/:personId/sleep/period', async (request, reply) => {
    const { person, today } = personAndToday(app, personIdOf(request))
    const { range, anchor, source } = periodQuery(request.query)
    const period = personQueryOf(request).sleepPeriod({
      range, anchor, today, source,
      sleepTargetMinutes: person.sleepTargetMinutes, sleepUseBaseline: person.sleepUseBaseline,
    })
    return sendHashed(reply, request, trimForWire(roundSleepPeriod(period), range))
  })

  app.get<{ Params: PersonParams, Querystring: PeriodQuery }>('/p/:personId/activity/period', async (request, reply) => {
    const { today } = personAndToday(app, personIdOf(request))
    const { range, anchor, source } = periodQuery(request.query)
    const period = personQueryOf(request).activityPeriod({ range, anchor, today, source })
    return sendHashed(reply, request, trimForWire(roundActivityPeriod(period), range))
  })
}
