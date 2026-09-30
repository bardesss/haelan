import type { FastifyInstance } from 'fastify'
import { balanceOf, ConfigError, readDayLog, requireDate, shiftLocalDate } from '@haelan/core'
import type { GlanceRecovery, MinuteSeries, NightPage, NightTrace, PaceSeries, WorkoutPage } from '@haelan/core'
import { errorBody, statusFor } from '../../api/envelope.ts'
import {
  personAndToday, personIdOf, personQueryOf, roundFigure, roundMetricValue, roundMetricValueOrNull, roundPageFigure,
  roundWorkoutFigure, sendHashed,
} from './shared.ts'

interface PersonParams { personId: string }
interface NightParams extends PersonParams { localDate: string }
interface WorkoutParams extends PersonParams { sessionId: string }

/** A share of time asleep, sent as a whole percent. */
function roundPercent(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(0))
}

/**
 * A night trace's extremes and mean at the trace metric's catalogue precision (heart_rate, hrv and
 * spo2 are all catalogue metrics, unlike the page-only figures above them), and its two figures by
 * roundPageFigure, which carry that same precision and are re-judged on their rounded numbers.
 */
function roundTrace(trace: NightTrace): NightTrace {
  const { metric, stat } = trace
  const extreme = (e: typeof stat.lowest) => (e === null ? null : { ...e, value: roundMetricValue(metric, e.value) })
  return {
    ...trace,
    stat: { lowest: extreme(stat.lowest), highest: extreme(stat.highest), mean: roundMetricValueOrNull(metric, stat.mean) },
    lowestFigure: roundPageFigure(trace.lowestFigure),
    meanFigure: roundPageFigure(trace.meanFigure),
  }
}

/**
 * The morning's recovery by the glance's rule, since its figures are glance figures: each through
 * roundFigure, re-judged on its rounded number. The night page's morning and the workout page's
 * morning before both send it this way.
 */
function roundRecovery(recovery: GlanceRecovery): GlanceRecovery {
  return {
    ...recovery,
    index: roundFigure(recovery.index),
    restingHeartRate: roundFigure(recovery.restingHeartRate),
    hrv: roundFigure(recovery.hrv),
    respiratoryRate: recovery.respiratoryRate === null ? null : roundFigure(recovery.respiratoryRate),
  }
}

/**
 * The night page at the wire's precision, the same boundary the glance rounds at: core keeps
 * every number unrounded, and only what is sent is rounded, before the hash so the ETag describes
 * the body a client receives. Every figure goes through roundPageFigure (its own precision), the
 * recovery figures through roundFigure (the glance's rule, since they are glance figures), and the
 * page's loose numbers to the metric they are measured in.
 */
function roundNightPage(page: NightPage): NightPage {
  const figures = Object.fromEntries(
    Object.entries(page.figures).map(([key, figure]) => [key, roundPageFigure(figure)]),
  ) as NightPage['figures']
  // The balance and the skin deviation are differences of numbers the page also shows, so each is
  // taken again from those numbers as sent. Rounded separately, seven nights of -79.6 are sent as
  // seven -80s beside a total of -557, and a deviation of 0.42 as 0.4 beside 33.5 and 33.0.
  const zeroMinutes = roundMetricValue('sleep_asleep_minutes', page.balance.zeroLine.minutes)
  const strip = figures.asleep.strip ?? []
  const balanced = balanceOf(strip.map((d) => d.value), zeroMinutes)
  const skinTemperature = roundPageFigure(page.morning.skinTemperature)
  const skinBaseline = skinTemperature.baseline
  return {
    ...page,
    figures,
    stagePercent: {
      deep: roundPercent(page.stagePercent.deep),
      light: roundPercent(page.stagePercent.light),
      rem: roundPercent(page.stagePercent.rem),
    },
    balance: {
      zeroLine: { ...page.balance.zeroLine, minutes: zeroMinutes },
      nights: strip.map((d, i) => ({ localDate: d.localDate, difference: balanced.values[i] ?? null })),
      total: balanced.total,
    },
    traces: {
      heartRate: roundTrace(page.traces.heartRate),
      hrv: roundTrace(page.traces.hrv),
      spo2: roundTrace(page.traces.spo2),
    },
    morning: {
      recovery: roundRecovery(page.morning.recovery),
      restingHeartRate: roundPageFigure(page.morning.restingHeartRate),
      hrv: roundPageFigure(page.morning.hrv),
      breathing: roundPageFigure(page.morning.breathing),
      spo2: roundPageFigure(page.morning.spo2),
      skinTemperature,
      // Core's null rules, on the rounded pair; rounded once more because 33.5 - 33.0 in floating
      // point need not come out exactly 0.5.
      skinTemperatureDeviation: skinTemperature.value === null || skinBaseline === null || skinBaseline.thin
        ? null : roundMetricValue('sleep_temperature', skinTemperature.value - skinBaseline.center),
    },
    day: {
      ...page.day,
      steps: roundPageFigure(page.day.steps),
      activeMinutes: roundPageFigure(page.day.activeMinutes),
    },
  }
}

/** A night beside a workout, before or after it, its two figures through roundPageFigure. */
function roundWorkoutNight(night: WorkoutPage['after']['night']): WorkoutPage['after']['night'] {
  return night === null ? null : { ...night, asleep: roundPageFigure(night.asleep), deep: roundPageFigure(night.deep) }
}

/** A minute series under the trace, each value whole: seconds per km as the pace figure is sent, steps per minute as cadence is. */
function roundMinuteSeries<T extends MinuteSeries>(series: T | null): T | null {
  return series === null ? null : { ...series, points: series.points.map((p) => ({ ...p, value: Number(p.value.toFixed(0)) })) }
}

/** Pace's series as roundMinuteSeries sends it, its fastest minute whole seconds per km, as its point is. */
function roundPaceSeries(series: PaceSeries | null): PaceSeries | null {
  const rounded = roundMinuteSeries(series)
  if (rounded === null || rounded.fastest === null) return rounded
  const { secondsPerKm, elapsedSeconds } = rounded.fastest
  return { ...rounded, fastest: { secondsPerKm: Number(secondsPerKm.toFixed(0)), elapsedSeconds: Number(elapsedSeconds.toFixed(0)) } }
}

/**
 * The workout page at the wire's precision, by the same rule as the night page. `previous` and
 * `best` carry pace in seconds, distance in metres, heart rate in bpm, load in TRIMP and a
 * duration in milliseconds: every one of them a whole number on the page's own figures
 * (workoutPage.ts's FIGURES, all precision 0), so each is sent whole. The previous ride's speed is
 * the exception, sent at the speed figure's own precision, since a whole metre per second is
 * 3.6 km/h.
 */
function roundWorkoutPage(page: WorkoutPage): WorkoutPage {
  const figures: WorkoutPage['figures'] = {}
  for (const [key, figure] of Object.entries(page.figures)) {
    if (figure !== undefined) figures[key as keyof WorkoutPage['figures']] = roundWorkoutFigure(figure)
  }
  const whole = (value: number) => Number(value.toFixed(0))
  const ref = (r: WorkoutPage['best']['fastestKmSeconds']) => (r === null ? null : { ...r, value: whole(r.value) })
  const { previous, after, before, heartRateRecovery, through, splitTrend, zoneBounds } = page
  return {
    ...page,
    figures,
    previous: previous === null ? null : {
      ...previous,
      values: Object.fromEntries(Object.entries(previous.values).map(([key, value]) => [
        key, key === 'speed' ? Number(value.toFixed(figures.speed?.precision ?? 2)) : whole(value),
      ])),
    },
    best: {
      fastestKmSeconds: ref(page.best.fastestKmSeconds),
      furthestMeters: ref(page.best.furthestMeters),
      longestMs: ref(page.best.longestMs),
    },
    day: { ...page.day, steps: roundPageFigure(page.day.steps), activeMinutes: roundPageFigure(page.day.activeMinutes) },
    after: {
      night: roundWorkoutNight(after.night),
      restingHeartRate: after.restingHeartRate === null ? null : roundPageFigure(after.restingHeartRate),
    },
    before: {
      night: roundWorkoutNight(before.night),
      recovery: before.recovery === null ? null : roundRecovery(before.recovery),
      restingHeartRate: before.restingHeartRate === null ? null : roundPageFigure(before.restingHeartRate),
    },
    heartRateRecovery: heartRateRecovery === null ? null : {
      oneMinute: roundPageFigure(heartRateRecovery.oneMinute), twoMinutes: roundPageFigure(heartRateRecovery.twoMinutes),
      // Whole bpm, as every heart rate is sent.
      readings: {
        endBpm: whole(heartRateRecovery.readings.endBpm),
        oneMinuteBpm: heartRateRecovery.readings.oneMinuteBpm === null ? null : whole(heartRateRecovery.readings.oneMinuteBpm),
        twoMinutesBpm: heartRateRecovery.readings.twoMinutesBpm === null ? null : whole(heartRateRecovery.readings.twoMinutesBpm),
      },
    },
    through: { pace: roundPaceSeries(through.pace), cadence: roundMinuteSeries(through.cadence) },
    // Whole seconds per km, as the pace figure is sent; whole bpm, as every heart rate is.
    splitTrend: splitTrend === null ? null : { secondHalfFasterBySecondsPerKm: whole(splitTrend.secondHalfFasterBySecondsPerKm) },
    zoneBounds: zoneBounds === null ? null : {
      moderateMin: whole(zoneBounds.moderateMin), vigorousMin: whole(zoneBounds.vigorousMin),
      peakMin: whole(zoneBounds.peakMin), max: whole(zoneBounds.max),
    },
  }
}

/**
 * The two detail pages (M10a): one night and one workout, each with the day's quick log beside it
 * so the page draws from one request. Hashed rather than stamped, as the glance is: each body
 * mixes sessions, samples and daily rows, and no single stamp covers them all.
 */
export function registerDetailRoutes(app: FastifyInstance): void {
  app.get<{ Params: NightParams }>('/p/:personId/night/:localDate', async (request, reply) => {
    const { person, nowMs, today, nameOf } = personAndToday(app, personIdOf(request))
    const { localDate } = request.params
    requireDate('localDate', localDate)
    if (localDate > today) throw new ConfigError(`localDate '${localDate}' is after today '${today}'`)
    const page = personQueryOf(request).nightPage({
      localDate, today, nowMs, nameOf,
      sleepTargetMinutes: person.sleepTargetMinutes, sleepUseBaseline: person.sleepUseBaseline,
    })
    if (page === null) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_night', `no night on '${localDate}'`))
    }
    // A night filed under D was slept after day D-1, so the log beside it is D-1's.
    const log = readDayLog(app.haelan.instance, person, shiftLocalDate(localDate, -1), today)
    return sendHashed(reply, request, { ...roundNightPage(page), log })
  })

  app.get<{ Params: WorkoutParams }>('/p/:personId/workout/:sessionId', async (request, reply) => {
    const { person, nowMs, today, nameOf } = personAndToday(app, personIdOf(request))
    const { sessionId } = request.params
    const page = personQueryOf(request).workoutPage({ sessionId, today, nowMs, nameOf })
    if (page === null) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_session', `no session '${sessionId}'`))
    }
    const log = readDayLog(app.haelan.instance, person, page.localDate, today)
    return sendHashed(reply, request, { ...roundWorkoutPage(page), log })
  })
}
