/**
 * The weight trend, computed rather than stored, for the reason M2d recorded about baselines: a
 * smoothed line over a series is a reading of the series, and storing it means a second thing to
 * rebuild whenever the series changes.
 */

export interface TrendPoint {
  localDate: string
  value: number
}

/**
 * Below this many contributing readings a smoothed line is not a trend, it is the readings
 * themselves with extra steps. Three is the floor a two point line cannot claim a direction from,
 * matching the reasoning `baselineOf`'s thin flag already applies to a short history.
 */
export const TREND_MIN_POINTS = 3

// A week-ish span: short enough that a real change shows up within days, long enough that one
// noisy reading cannot swing the line back and forth. alpha = 2 / (span + 1) is the standard
// conversion from a span in periods to an exponential smoothing constant.
const SPAN_DAYS = 7
const ALPHA = 2 / (SPAN_DAYS + 1)

/**
 * An exponentially weighted moving average over a daily series, seeded by the first reading so
 * the smoothed line starts exactly where the data does rather than drifting in from an assumed
 * prior. Needs no window centred on the future, which is what makes the most recent point real
 * rather than provisional.
 *
 * A day with no reading is skipped rather than treated as zero, and is absent from the output
 * rather than appearing with an invented value: the day itself carried no measurement, and a
 * trend line has nothing to draw there.
 */
export function trendOf(points: readonly { localDate: string, value: number | null }[]): TrendPoint[] {
  const readings = points.filter(
    (point): point is { localDate: string, value: number } => point.value !== null,
  )
  if (readings.length < TREND_MIN_POINTS) return []

  const out: TrendPoint[] = []
  let smoothed = readings[0]!.value
  out.push({ localDate: readings[0]!.localDate, value: smoothed })
  for (let i = 1; i < readings.length; i += 1) {
    smoothed = ALPHA * readings[i]!.value + (1 - ALPHA) * smoothed
    out.push({ localDate: readings[i]!.localDate, value: smoothed })
  }
  return out
}
