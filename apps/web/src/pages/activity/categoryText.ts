import { rateOf } from '@haelan/core/exercise-category'
import type { ExerciseCategory } from '@haelan/core/exercise-category'
import type { Translate } from '../../format.js'
import { figureAs, formatFigureValue } from '../detail/figureText.js'


/** The two rates a session or a record can carry: its pace per km, and a ride's speed as core sends it. */
export interface SessionRates { paceSecondsPerKm: number | null, speedMetersPerSecond: number | null }

/**
 * A session's average rate as its category reads it (PATTERNS.md, "Per sport"): pace for a run or
 * a walk ("5:24 /km"), speed for a ride ("27.0 km/h", "km/u" in Dutch), the time for each 100 m
 * for a swim ("2:05 /100 m"), and nothing for a category with no rate. A ride reads the speed core
 * sends (sessions.ts's rideSpeedOf, the workout page's own rule), never its pace turned round, so a
 * ride with no device pace still shows its speed; the others read the session's pace. Through
 * formatFigureValue, the workout page's own formatter for each of the three.
 */
export function sessionRateText(
  category: ExerciseCategory, rates: SessionRates, language: string, t: Translate,
): string | null {
  const { paceSecondsPerKm: pace, speedMetersPerSecond: speed } = rates
  switch (rateOf(category)) {
    case 'speed': return speed === null || speed <= 0 ? null : formatFigureValue(figureAs('speed', 'meters_per_second'), speed, language, t)
    case 'pace': return pace === null || pace <= 0 ? null : formatFigureValue(figureAs('pace', 'seconds_per_km'), pace, language, t)
    case 'swimPace': return pace === null || pace <= 0 ? null : formatFigureValue(figureAs('swimPace', 'seconds_per_100m'), pace / 10, language, t)
    default: return null
  }
}

/** A swim's distance, in whole metres however far it went ("1,500 m"): a pool counts in metres. */
export function swimDistanceText(meters: number, language: string, t: Translate): string {
  return formatFigureValue(figureAs('swimDistance', 'meters'), meters, language, t)
}

/**
 * A distance as every list reads one, a session's or a total alike: a swim's in whole metres, any
 * other in km to one decimal below 100 and whole above ("8.5 km", "183 km", formatFigureValue's
 * rule for a day's or a period's distance), under a kilometre in metres. The Activity page's rows and per-type totals and the
 * Records page all print through this, so one distance never reads two ways on one screen. The
 * workout page, about one session, keeps its two decimals.
 */
export function distanceText(category: ExerciseCategory | null, meters: number, language: string, t: Translate): string {
  if (category === 'swim') return swimDistanceText(meters, language, t)
  // Under a kilometre in whole metres ("800 m"), as formatFigureValue's metres read.
  if (meters < 1000) return formatFigureValue(figureAs('distance', 'meters'), meters, language, t)
  return formatFigureValue(figureAs('distance', 'millimeters'), meters * 1000, language, t)
}
