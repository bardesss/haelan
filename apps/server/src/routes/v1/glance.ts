import type { FastifyInstance } from 'fastify'
import {
  ConfigError, effectiveTimezone, localDateInZone, localMidnightMs, readDayLog, requireDate, shiftLocalDate, standingOf,
  judgeCalendarDay, readGlanceCalendarRaw,
} from '@haelan/core'
import type {
  Glance, GlanceCalendar, GlanceStepsPace, GlanceWeekFigure, RawCalendarDay,
} from '@haelan/core'
import { personQueryOf, roundBand, roundFigure, roundMetricValue, roundMetricValueOrNull, ROUNDED_AS, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

/**
 * The pace band and its own count, each to steps precision, with `standing` recomputed from those
 * rounded numbers through the same `standingOf` used everywhere else, its `within/above/below`
 * mapped onto the pace's own `on/ahead/behind` words. Null stays null: `standingOf` alone already
 * covers a thin band, and a pace core decided is too early to judge (`readStepsPace`'s
 * `PACE_MIN_DAY_SHARE` gate) is never sent with a non-null standing for rounding to disturb.
 */
function roundPace(pace: GlanceStepsPace | null): GlanceStepsPace | null {
  if (pace === null) return null
  const band = {
    center: roundMetricValue('steps', pace.center),
    low: roundMetricValue('steps', pace.low),
    high: roundMetricValue('steps', pace.high),
    thin: pace.thin,
  }
  const value = roundMetricValue('steps', pace.value)
  const verdict = pace.standing === null ? null : standingOf(value, band, false)
  const standing = verdict === null ? null : verdict === 'above' ? 'ahead' : verdict === 'below' ? 'behind' : 'on'
  return { ...pace, ...band, value, standing }
}

/** A week figure's `perDay` and `total`, each rounded to its metric's catalogue precision; `days` is a count, never rounded. */
function roundWeekFigure(metric: string, figure: GlanceWeekFigure | null): GlanceWeekFigure | null {
  return figure === null ? null : {
    ...figure, perDay: roundMetricValue(metric, figure.perDay), total: roundMetricValue(metric, figure.total),
  }
}

/**
 * The glance at catalogue precision, the same boundary /series and /intraday round at: core keeps
 * full precision (a baseline's centre is a mean, and a spread either side of it is rarely a round
 * number), and only what goes over the wire is rounded. Before the hash, so the ETag describes
 * the body a client actually receives.
 */
function roundGlance(glance: Glance): Glance {
  const { sleep, recovery, day, week } = glance
  return {
    ...glance,
    sleep: sleep === null ? null : {
      ...sleep,
      asleep: roundFigure(sleep.asleep),
      efficiency: roundFigure(sleep.efficiency),
      bedtime: roundFigure(sleep.bedtime),
      waketime: roundFigure(sleep.waketime),
    },
    recovery: {
      ...recovery,
      index: roundFigure(recovery.index),
      restingHeartRate: roundFigure(recovery.restingHeartRate),
      hrv: roundFigure(recovery.hrv),
      respiratoryRate: recovery.respiratoryRate === null ? null : roundFigure(recovery.respiratoryRate),
    },
    // Spread first, as sleep and recovery above are: `workouts` carries nothing to round, and a
    // rebuild that named only the fields it rounds dropped it from the body entirely.
    day: {
      ...day,
      steps: roundFigure(day.steps),
      stepsPace: roundPace(day.stepsPace),
      activeMinutes: roundFigure(day.activeMinutes),
      heartRate: {
        ...day.heartRate,
        points: day.heartRate.points.map((point) => ({
          ...point,
          min: roundMetricValueOrNull('heart_rate', point.min),
          mean: roundMetricValueOrNull('heart_rate', point.mean),
          max: roundMetricValueOrNull('heart_rate', point.max),
        })),
      },
    },
    week: {
      steps: roundWeekFigure('steps', week.steps),
      activeMinutes: roundWeekFigure(ROUNDED_AS.active_minutes!, week.activeMinutes),
      asleep: roundWeekFigure('sleep_asleep_minutes', week.asleep),
    },
  }
}

/**
 * A raw calendar day's two values and bands, rounded to each metric's catalogue precision before
 * `judgeCalendarDay` runs on them - the same split `/glance` keeps between core's unrounded
 * figures and the wire's rounded ones (Task 19a), so a day that only clears its band before
 * rounding cannot disagree with the dots a person is actually shown.
 */
function roundRawCalendarDay(raw: RawCalendarDay): RawCalendarDay {
  return {
    ...raw,
    sleepValue: roundMetricValueOrNull('sleep_asleep_minutes', raw.sleepValue),
    sleepBand: roundBand('sleep_asleep_minutes', raw.sleepBand),
    stepsValue: roundMetricValueOrNull('steps', raw.stepsValue),
    stepsBand: roundBand('steps', raw.stepsBand),
  }
}

/**
 * The glance (M9a): last night, today's recovery and today so far, for the dashboard and the
 * native app. No parameters, like /all-time: today is the person's own civil date in their own
 * zone, decided here, so the web page and the phone cannot disagree about which day it is.
 *
 * `day` (M9c: day navigation) asks for a finished day instead of today, built as if that day had
 * just ended. Validation is layered so the 400s the spec asks for come out in order: a malformed
 * date, one in the future, and one before the first day with data, all read the same as any other
 * ConfigError through registerV1's error handler. A day inside the range but with no data of its
 * own answers 404 with `{ nearest }` instead of throwing, since that is not a caller error - it is
 * the server naming the day the page should actually open.
 *
 * Source names are resolved here rather than in core, because an alias is instance state and
 * PersonQuery reads only what the person's rows say. Hashed rather than stamped: the body mixes
 * nights, samples and daily rows, and no single stamp covers all three.
 */
export function registerGlanceRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: { day?: string } }>('/p/:personId/glance', async (request, reply) => {
    const { personId } = request.params
    const nowMs = app.haelan.now()
    const person = app.haelan.stores.people.get(personId)
    // Today and a past day's bounds follow the effective zone (the phone's when it leads), so a
    // traveller's glance turns over at their own midnight. Source names stay on the home zone:
    // a default name's first-seen date is a fact about the archive, not about where they are now.
    const tz = person === null ? 'UTC' : effectiveTimezone(person)
    const today = localDateInZone(nowMs, tz)
    const names = new Map(app.haelan.instance.sourceAliases.listNamed(personId, person?.timezone).map((s) => [s.id, s.name]))
    const nameOf = (id: string) => names.get(id) ?? id
    const q = personQueryOf(request)

    const dayParam = request.query.day
    let effectiveDay = today
    if (dayParam !== undefined) {
      requireDate('day', dayParam)
      if (dayParam > today) throw new ConfigError(`day '${dayParam}' is after today '${today}'`)
      const firstDay = q.nearestDayWithData({ on: '0000-01-01', direction: 'after' })
      if (firstDay === null || dayParam < firstDay) {
        throw new ConfigError(`day '${dayParam}' is before the first day with data`)
      }
      if (dayParam !== today) {
        const hasData = q.daysWithData({ from: dayParam, to: dayParam }).length > 0
        if (!hasData) {
          const nearest = q.nearestDayWithData({ on: dayParam, direction: 'before' })
            ?? q.nearestDayWithData({ on: dayParam, direction: 'after' })
          return reply.code(404).send({ nearest })
        }
        effectiveDay = dayParam
      }
    }

    // A past day's end in the effective zone bounds nothing a reader sees as a time: its last
    // night is the night filed under that day (readLastNight), from east or west of where it was
    // slept, and its heart-rate trace carries the offset it was recorded under, so a day lived
    // elsewhere is not shifted into this zone.
    // core's own readGlance already fills in `finished` and `nav` (Glance's own fields); nothing
    // here needs to recompute either, and roundGlance's `...glance` spread carries both through
    // to the wire unchanged.
    const result: Glance = q.glance(effectiveDay === today
      ? { today, nowMs, nameOf }
      : { today, nowMs, nameOf, day: effectiveDay, dayEndMs: localMidnightMs(shiftLocalDate(effectiveDay, 1), tz) - 1 })

    // The day's log rides on the glance only for a person who turned quick logging on (M9c), so
    // one request still draws the page and a client needs no second read to know whether to show
    // the button. Absent, not null, when off. The log carries the real today even on a past day's
    // glance, whose own `today` names the day shown.
    const body = person?.quickLogEnabled === true
      ? { ...roundGlance(result), log: readDayLog(app.haelan.instance, person, effectiveDay, today) }
      : roundGlance(result)
    return sendHashed(reply, request, body)
  })

  app.get<{ Params: PersonParams, Querystring: { month?: string } }>('/p/:personId/glance/calendar', async (request, reply) => {
    const { personId } = request.params
    const nowMs = app.haelan.now()
    const person = app.haelan.stores.people.get(personId)
    const today = localDateInZone(nowMs, person === null ? 'UTC' : effectiveTimezone(person))
    const month = request.query.month
    if (month === undefined) throw new ConfigError('month is required')

    const raw = readGlanceCalendarRaw(personQueryOf(request), { month, today })
    const result: GlanceCalendar = {
      month: raw.month,
      firstDay: raw.firstDay,
      days: raw.days.map((day) => judgeCalendarDay(roundRawCalendarDay(day))),
    }
    return sendHashed(reply, request, result)
  })
}
