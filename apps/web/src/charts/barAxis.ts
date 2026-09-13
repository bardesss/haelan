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

/**
 * What a daily bar chart's x axis prints for each of `dates`: `MM-DD` once they cross into a
 * second calendar month, day-of-month (`DD`) alone when every date shares one.
 *
 * Day-of-month alone is what a reader needs at a week or a month: the numbers are distinct and
 * the card's own period line already says which month they are in. Past that it stops answering
 * the question the axis exists for. Measured off the real option at this branch's two ranges
 * still not fixed:
 *
 *   90 points   14 29 14 29 13 28   - the same two numbers, four times over
 *   365 points  14 13 12 13 12 11 09 - seven near-identical numbers, no month anywhere
 *
 * `MM-DD` fixes both (measured at about 32px per label against 74px of available spacing, so it
 * fits at every range this chart draws) without needing a second, denser axis design.
 *
 * Derived from the dates' own months, not from how many of them there are: a count threshold
 * (say, "more than 40 points means MM-DD") cannot tell a range that stays inside one calendar
 * month from one that has actually crossed into a second, and would print a month on the former
 * that the reader does not need. 31 dates spanning the whole of August and nothing else, all
 * called with day-of-month alone below, is the case a count-based rule would get wrong.
 */
export function barDateLabels(dates: readonly string[]): string[] {
  const spansMonths = new Set(dates.map((date) => date.slice(0, 7))).size > 1
  return dates.map((date) => (spansMonths ? date.slice(5) : date.slice(8)))
}
