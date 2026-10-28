import type { FastifyInstance } from 'fastify'
import type { BodyAgeRead } from '@haelan/core'
import type { BodyAge, BodyAgeAvailable, BodyAgeFactor, BodyAgeFactorKey, BodyAgeMonth } from '@haelan/core/body-age'
import { personAndToday, personIdOf, personQueryOf, roundTo as roundToRaw, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

// `+ 0` turns the -0 that rounding a small negative gives into 0, so "at the reference" is one
// value on the wire and in a tool's structured result, as `yearsOf` keeps it in core.
const roundTo = (precision: number, value: number): number => roundToRaw(precision, value) + 0
const roundToOrNull = (precision: number, value: number | null): number | null =>
  value === null ? null : roundTo(precision, value)

// A factor value at its own unit's natural precision: a VO2 reading to a tenth, a heart rate to a
// beat, a bedtime spread to a minute, sessions a week to a tenth. The reference is a value of the
// same kind, so it follows. `hrv` is never in a read today (the factor was dropped as uncitable) but
// the key still exists in the type, and a total map is how a new key fails to compile here.
const VALUE_PRECISION: Record<BodyAgeFactorKey, number> = {
  vo2Max: 1, restingHeartRate: 0, hrv: 0, activity: 0, sleepRegularity: 0, strength: 1,
}

const roundFactor = (f: BodyAgeFactor): BodyAgeFactor => ({
  ...f,
  value: roundToOrNull(VALUE_PRECISION[f.key], f.value),
  reference: roundToOrNull(VALUE_PRECISION[f.key], f.reference),
  years: roundTo(1, f.years),
})

const roundMonth = (m: BodyAgeMonth): BodyAgeMonth => ({
  ...m, bodyAge: roundTo(1, m.bodyAge), calendarAge: roundTo(1, m.calendarAge), gap: roundTo(1, m.gap),
})

function roundAvailable(b: BodyAgeAvailable): BodyAgeAvailable {
  return {
    ...b,
    calendarAge: roundTo(1, b.calendarAge),
    bodyAge: roundTo(1, b.bodyAge),
    gap: roundTo(1, b.gap),
    factors: b.factors.map(roundFactor),
    mostRoom: b.mostRoom === null ? null : { ...b.mostRoom, years: roundTo(1, b.mostRoom.years) },
    fitnessAge: roundToOrNull(1, b.fitnessAge),
  }
}

const roundCurrent = (b: BodyAge | null): BodyAge | null => (b === null || !b.enough ? b : roundAvailable(b))

/**
 * The body age read at the wire's precision: ages, years and gaps to a tenth, the pace to a
 * hundredth, each factor value to its unit's own. Nothing is judged again from the rounded numbers,
 * because core's verdicts here (`carriedBy`, `mostRoom`, `capped`) are names and flags that rounding
 * cannot move. `method` is constants and passes through whole.
 */
export function roundBodyAge(read: BodyAgeRead): BodyAgeRead {
  return {
    ...read,
    current: roundCurrent(read.current),
    previous: read.previous === null ? null : roundAvailable(read.previous),
    months: read.months.map(roundMonth),
    pace: roundToOrNull(2, read.pace),
    youngest: read.youngest === null ? null : roundMonth(read.youngest),
  }
}

/**
 * The body age, its history and the method behind it, in one call.
 *
 * No parameters, like all-time: the figure is read at the person's last scored day, not over a
 * range, so a `from` or `to` would be a parameter that either lies or does nothing. `today` comes
 * from the person's own zone, as every other overview route's does, and only caps which days count.
 */
export function registerBodyAgeRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams }>('/p/:personId/body-age', async (request, reply) => {
    const { today } = personAndToday(app, personIdOf(request))
    return sendHashed(reply, request, roundBodyAge(personQueryOf(request).bodyAge({ today })))
  })
}
