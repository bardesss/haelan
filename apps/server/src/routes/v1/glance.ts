import type { FastifyInstance } from 'fastify'
import { localDateInZone } from '@haelan/core'
import type { Glance, GlanceFigure } from '@haelan/core'
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

/** A figure's value, band and strip, each to its metric's catalogue precision. */
function roundFigure(figure: GlanceFigure): GlanceFigure {
  const metric = ROUNDED_AS[figure.metric] ?? figure.metric
  const { baseline } = figure
  return {
    ...figure,
    value: roundMetricValueOrNull(metric, figure.value),
    baseline: baseline === null ? null : {
      ...baseline,
      center: roundMetricValue(metric, baseline.center),
      low: roundMetricValue(metric, baseline.low),
      high: roundMetricValue(metric, baseline.high),
    },
    strip: figure.strip.map((day) => ({ ...day, value: roundMetricValueOrNull(metric, day.value) })),
  }
}

/**
 * The glance at catalogue precision, the same boundary /series and /intraday round at: core keeps
 * full precision (a baseline's centre is a mean, and a spread either side of it is rarely a round
 * number), and only what goes over the wire is rounded. Before the hash, so the ETag describes
 * the body a client actually receives.
 */
function roundGlance(glance: Glance): Glance {
  const { sleep, recovery, day } = glance
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
      stepsPace: day.stepsPace === null ? null : {
        ...day.stepsPace,
        center: roundMetricValue('steps', day.stepsPace.center),
        low: roundMetricValue('steps', day.stepsPace.low),
        high: roundMetricValue('steps', day.stepsPace.high),
      },
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
