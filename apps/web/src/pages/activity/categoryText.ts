import type { ExerciseCategory, SessionRate } from '@haelan/core/exercise-category'
import type { Translate } from '../../format.js'
import { figureAs, formatFigureValue } from '../detail/figureText.js'


/**
 * A session's average rate as the server sends it (core's sessionRateOf, PATTERNS.md "Per sport"):
 * pace on foot ("5:24 /km"), speed on a bike ("27.0 km/h", "km/u" in Dutch), the time for each
 * 100 m in the water ("2:05 /100 m"), and nothing where the server sends none. The server picks
 * the rate by the workout page's own rules and names its key and unit, so this only words it,
 * through formatFigureValue, the workout page's own formatter for each of the three.
 */
export function sessionRateText(rate: SessionRate | null, language: string, t: Translate): string | null {
  return rate === null ? null : formatFigureValue(figureAs(rate.key, rate.unit), rate.value, language, t)
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
