// This is the only module allowed to open a WorkoutSession's attrs blob. See useSessions.ts.

export interface WorkoutSummary {
  exerciseType: string | null
  caloriesKcal: number | null
  averageHeartRateBpm: number | null
  distanceMeters: number | null
  steps: number | null
  paceSecondsPerKm: number | null
  elevationGainMeters: number | null
  activeZoneMinutes: number | null
}

const ALL_NULL_SUMMARY: WorkoutSummary = {
  exerciseType: null,
  caloriesKcal: null,
  averageHeartRateBpm: null,
  distanceMeters: null,
  steps: null,
  paceSecondsPerKm: null,
  elevationGainMeters: null,
  activeZoneMinutes: null,
}

const MILLIMETERS_PER_METER = 1000
const METERS_PER_KM = 1000

/**
 * The provider mixes JSON types inside one object: caloriesKcal and distanceMillimeters arrive as
 * numbers, while averageHeartRateBeatsPerMinute, steps and activeZoneMinutes arrive as strings.
 * Roughly half the fields are absent on any given session, and only 97 of 192 real sessions carry a
 * distance at all.
 *
 * Presence is tested before the value is coerced, never after. Number(null) is 0 and Number('') is
 * 0, so a reader that coerces first turns a field the session never recorded into a printed zero,
 * and "no distance recorded" and "0 km" are different statements about a workout.
 *
 * A recorded zero survives, from either type. A guard written as `value ? Number(value) : null`
 * would satisfy the absence cases above and silently discard a real zero, which is why the tests
 * assert both directions.
 */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The route answers attrs as whatever was stored for that session, and this app has no error
 * boundary: a reader that throws here unmounts the whole page rather than dropping one row. attrs
 * is also one shape across both session kinds, so an exercise row carries the sleep fields present
 * and set to null; narrowing to a record and reading through numberOrNull handles that without
 * asserting a type.
 */
export function workoutSummary(attrs: unknown): WorkoutSummary {
  if (!isRecord(attrs)) return ALL_NULL_SUMMARY

  const exerciseType = typeof attrs.exerciseType === 'string' ? attrs.exerciseType : null
  const metrics = isRecord(attrs.metricsSummary) ? attrs.metricsSummary : {}

  const distanceMillimeters = numberOrNull(metrics.distanceMillimeters)
  const elevationGainMillimeters = numberOrNull(metrics.elevationGainMillimeters)
  const averagePaceSecondsPerMeter = numberOrNull(metrics.averagePaceSecondsPerMeter)

  return {
    exerciseType,
    caloriesKcal: numberOrNull(metrics.caloriesKcal),
    averageHeartRateBpm: numberOrNull(metrics.averageHeartRateBeatsPerMinute),
    distanceMeters: distanceMillimeters === null ? null : distanceMillimeters / MILLIMETERS_PER_METER,
    steps: numberOrNull(metrics.steps),
    paceSecondsPerKm: averagePaceSecondsPerMeter === null
      ? null
      : averagePaceSecondsPerMeter * METERS_PER_KM,
    elevationGainMeters: elevationGainMillimeters === null
      ? null
      : elevationGainMillimeters / MILLIMETERS_PER_METER,
    activeZoneMinutes: numberOrNull(metrics.activeZoneMinutes),
  }
}
