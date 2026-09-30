import { rateOf } from '@haelan/core/exercise-category'
import type { ExerciseCategory } from '@haelan/core/exercise-category'
import type { Translate } from '../../format.js'
import { figureAs, formatFigureValue } from '../detail/figureText.js'


/**
 * A session's average rate as its category reads it (PATTERNS.md, "Per sport"): pace for a run or
 * a walk ("5:24 /km"), speed for a ride ("27.0 km/h", "km/u" in Dutch), the time for each 100 m
 * for a swim ("2:05 /100 m"), and nothing for a category with no rate. Read off the session's own
 * pace, the one rate a summary carries, so a ride's speed is that pace turned round. Through
 * formatFigureValue, the workout page's own formatter for each of the three.
 */
export function sessionRateText(
  category: ExerciseCategory, paceSecondsPerKm: number | null, language: string, t: Translate,
): string | null {
  if (paceSecondsPerKm === null || paceSecondsPerKm <= 0) return null
  switch (rateOf(category)) {
    case 'pace': return formatFigureValue(figureAs('pace', 'seconds_per_km'), paceSecondsPerKm, language, t)
    case 'speed': return formatFigureValue(figureAs('speed', 'meters_per_second'), 1000 / paceSecondsPerKm, language, t)
    case 'swimPace': return formatFigureValue(figureAs('swimPace', 'seconds_per_100m'), paceSecondsPerKm / 10, language, t)
    default: return null
  }
}

/** A swim's distance, in whole metres however far it went ("1,500 m"): a pool counts in metres. */
export function swimDistanceText(meters: number, language: string, t: Translate): string {
  return formatFigureValue(figureAs('swimDistance', 'meters'), meters, language, t)
}
