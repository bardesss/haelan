import type { FastifyInstance } from 'fastify'
import { localDateInZone, standingOf } from '@haelan/core'
import type { Glance, GlanceFigure, GlanceStepsPace, GlanceWeekFigure } from '@haelan/core'
import { personQueryOf, roundMetricValue, roundMetricValueOrNull, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

/**
 * The catalogue metric a figure is rounded as, for the figures whose own metric is not a
 * catalogue id. Active minutes is the three activity levels summed, all minutes metrics sharing
 * one precision, so it rounds as one of them does. The recovery index is absent on purpose: it is
 * already an integer, and roundMetricValue passes a metric the catalogue does not know through
 * unchanged, so it needs no entry and no second rounding rule.
 */
const ROUNDED_AS: Readonly<Record<string, string>> = { active_minutes: 'active_minutes_light' }

/**
 * A figure's value, band and strip, each to its metric's catalogue precision, with every verdict
 * recomputed from those same rounded numbers (Task 19a): `standingOf` runs on unrounded values in
 * core, so a value that only clears its baseline's high before rounding (or only after) would
 * otherwise disagree with the band a reader is actually shown, e.g. "60 bpm, above your usual
 * 52 - 60". One rule (`standingOf`), reapplied here at the wire's own precision; core's callers
 * (MCP and others) keep the unrounded figure, so their own comparisons stay internally consistent.
 */
function roundFigure(figure: GlanceFigure): GlanceFigure {
  const metric = ROUNDED_AS[figure.metric] ?? figure.metric
  const { baseline } = figure
  const band = baseline === null ? null : {
    ...baseline,
    center: roundMetricValue(metric, baseline.center),
    low: roundMetricValue(metric, baseline.low),
    high: roundMetricValue(metric, baseline.high),
  }
  const value = roundMetricValueOrNull(metric, figure.value)
  // The figure's own day is always the strip's last entry (stripDates ends on `on`); `partial`
  // never applies to an earlier, already-finished day in the same strip (glance.ts's stripOf).
  const ownDate = figure.strip.at(-1)?.localDate ?? null
  return {
    ...figure,
    value,
    baseline: band,
    strip: figure.strip.map((day) => {
      const dayValue = roundMetricValueOrNull(metric, day.value)
      return { ...day, value: dayValue, standing: standingOf(dayValue, band, figure.partial && day.localDate === ownDate) }
    }),
    standing: standingOf(value, band, figure.partial),
  }
}

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
 * The glance (M9a): last night, today's recovery and today so far, for the dashboard and the
 * native app. No parameters, like /all-time: today is the person's own civil date in their own
 * zone, decided here, so the web page and the phone cannot disagree about which day it is.
 *
 * Source names are resolved here rather than in core, because an alias is instance state and
 * PersonQuery reads only what the person's rows say. Hashed rather than stamped: the body mixes
 * nights, samples and daily rows, and no single stamp covers all three.
 */
export function registerGlanceRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams }>('/p/:personId/glance', async (request, reply) => {
    const { personId } = request.params
    const nowMs = app.haelan.now()
    const person = app.haelan.stores.people.get(personId)
    const today = localDateInZone(nowMs, person?.timezone ?? 'UTC')
    const names = new Map(app.haelan.instance.sourceAliases.listNamed(personId).map((s) => [s.id, s.name]))
    const result: Glance = personQueryOf(request).glance({ today, nowMs, nameOf: (id) => names.get(id) ?? id })
    return sendHashed(reply, request, roundGlance(result))
  })
}
