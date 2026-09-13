/** About this many x labels at any range: enough to place a bar, few enough not to collide. */
const TARGET_LABELS = 6

/**
 * What to pass echarts as `axisLabel.interval` for a daily bar chart of `points` days.
 *
 * echarts counts labels to SKIP, not labels to draw, so 0 is "every one" and 4 is "every fifth".
 * Derived from the point count rather than hardcoded per range, because one promoted card draws 7,
 * 30, 90 and 365 points from the same component - `SleepSchedule`'s `interval: 4` is right for the
 * single width it draws at and would leave a year of daily labels on top of each other here.
 *
 * Floored at 0. A negative interval is not "draw more", it is "draw nothing", so a range with
 * fewer points than the target would otherwise lose its axis entirely.
 *
 * `Math.floor`, not `Math.ceil`: at a week, ceil puts the interval at 1 and drops every other
 * date, which is thinning seven labels that fit comfortably. Floor rounds toward drawing more, and
 * the cost of that choice shows up only at a year, where it draws about seven labels rather than
 * about six.
 */
export function barLabelInterval(points: number): number {
  return Math.max(0, Math.floor(points / TARGET_LABELS) - 1)
}
