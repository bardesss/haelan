import type { FastifyInstance } from 'fastify'
import {
  balanceOf, ConfigError, countsOf, highOf, judge, PERIOD_RANGES, periodBounds, requireDate, standingOf, vo2TrendOf,
} from '@haelan/core'
import type { ActivityPeriod, PeriodChange, PeriodFigure, PeriodRange, PeriodStripPoint, SleepPeriod } from '@haelan/core'
import {
  personAndToday, personIdOf, personQueryOf, requireString, roundBandTo, roundMetricValue, roundToOrNull, sendHashed,
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

const whole = (value: number) => Number(value.toFixed(0))
const wholeOrNull = (value: number | null) => (value === null ? null : whole(value))

/**
 * The Sleep overview at the wire's precision. Every figure goes through roundPeriodFigure; the
 * numbers taken from the hero (the longest night, the changes, the balance and the nights list)
 * are taken again from the rounded hero, so none of them can disagree with a dot the page draws.
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
  const share = (v: number) => Number(v.toFixed(3))
  const side = (s: SleepPeriod['schedule']['sides']['weekday']) =>
    (s === null ? null : { ...s, bedtimeMinutes: whole(s.bedtimeMinutes), waketimeMinutes: whole(s.waketimeMinutes) })
  let balance: SleepPeriod['balance'] = null
  if (p.balance !== null) {
    const zeroMinutes = roundMetricValue('sleep_asleep_minutes', p.balance.zeroLine.minutes)
    const balanced = balanceOf(hero.daily.map((d) => d.value), zeroMinutes)
    balance = { zeroLine: { ...p.balance.zeroLine, minutes: zeroMinutes }, values: balanced.values, total: balanced.total }
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
        : { deep: share(shares.deep), light: share(shares.light), rem: share(shares.rem), awake: share(shares.awake) },
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
      durationSeconds: wholeOrNull(w.durationSeconds),
      distanceMeters: wholeOrNull(w.distanceMeters),
      caloriesKcal: wholeOrNull(w.caloriesKcal),
      averageHeartRateBpm: wholeOrNull(w.averageHeartRateBpm),
    })),
    types: p.types.map((t) => {
      const usualCount = roundBandTo(1, t.usualCount)
      return {
        ...t,
        seconds: whole(t.seconds),
        distanceMeters: wholeOrNull(t.distanceMeters),
        usualCount,
        standing: standingOf(t.count, usualCount, p.period.partial),
      }
    }),
    cardioLoad: roundOrNull(p.cardioLoad),
    vo2max: vo2max === null ? null : (() => {
      const latest = Number(vo2max.latest.toFixed(1))
      const earlier = roundToOrNull(1, vo2max.earlier)
      return { ...vo2max, latest, earlier, trend: vo2TrendOf(latest, earlier) }
    })(),
    more: p.more.map(roundPeriodFigure),
  }
}

/**
 * The range, anchor and source every period read takes, refused here in the route's own words
 * before core sees them. `all` (or no source) is the merge; any other value is passed through, and
 * core refuses an unknown or derived source name with a 400, as /insights does.
 */
function periodQuery(query: PeriodQuery, today: string): { range: PeriodRange, anchor: string, source: string | undefined } {
  const range = requireString(query.range, 'range')
  if (!(PERIOD_RANGES as readonly string[]).includes(range)) {
    throw new ConfigError(`range must be one of ${PERIOD_RANGES.join(', ')}, got '${range}'`)
  }
  const anchor = requireString(query.anchor, 'anchor')
  requireDate('anchor', anchor)
  const { from } = periodBounds(range as PeriodRange, anchor)
  if (from > today) throw new ConfigError(`the ${range} of '${anchor}' starts after today '${today}'`)
  const source = query.source === undefined || query.source === 'all' ? undefined : query.source
  return { range: range as PeriodRange, anchor, source }
}

/**
 * The two overview reads (M10b): a week, month, three months or year of Sleep or Activity. Hashed
 * rather than stamped, as the detail pages are: each body mixes sessions and daily rows.
 */
export function registerPeriodRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: PeriodQuery }>('/p/:personId/sleep/period', async (request, reply) => {
    const { person, today } = personAndToday(app, personIdOf(request))
    const { range, anchor, source } = periodQuery(request.query, today)
    const period = personQueryOf(request).sleepPeriod({
      range, anchor, today, source,
      sleepTargetMinutes: person.sleepTargetMinutes, sleepUseBaseline: person.sleepUseBaseline,
    })
    return sendHashed(reply, request, roundSleepPeriod(period))
  })

  app.get<{ Params: PersonParams, Querystring: PeriodQuery }>('/p/:personId/activity/period', async (request, reply) => {
    const { today } = personAndToday(app, personIdOf(request))
    const { range, anchor, source } = periodQuery(request.query, today)
    return sendHashed(reply, request, roundActivityPeriod(personQueryOf(request).activityPeriod({ range, anchor, today, source })))
  })
}
