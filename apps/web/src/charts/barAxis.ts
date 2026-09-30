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

/** An overview chart's own x labels: one per point, and which of them are printed. */
export interface PeriodAxis { data: string[], shown: boolean[] }

/**
 * The x labels of an overview page's bar charts (the stages, the balance), by the range, as the
 * approved mockups print them: a week's weekdays ("ma di wo"), a month's day numbers every seventh
 * day ("1 8 15 22 29"), and on 3 months and Year, whose points are weeks, each month's name under
 * the first week that starts in it ("jan feb mrt"). The tooltip and the table keep the full dates.
 * Memoise it: it reaches the chart build.
 */
export function periodAxisLabels(dates: readonly string[], range: 'week' | 'month' | '3months' | 'year', language: string): PeriodAxis {
  const at = (date: string) => Date.parse(`${date}T00:00:00Z`)
  if (range === 'week') {
    const weekday = new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' })
    return { data: dates.map((date) => weekday.format(at(date))), shown: dates.map(() => true) }
  }
  if (range === 'month') {
    const day = (date: string) => Number(date.slice(8, 10))
    return { data: dates.map((date) => String(day(date))), shown: dates.map((date) => (day(date) - 1) % 7 === 0) }
  }
  const month = new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' })
  return {
    data: dates.map((date) => month.format(at(date))),
    shown: dates.map((date, i) => i === 0 || date.slice(0, 7) !== dates[i - 1]!.slice(0, 7)),
  }
}

/**
 * The top of a value axis ticked every `step`: the data's own maximum when it passes a step by a
 * quarter of one or less, so a night of 8h 05m keeps an axis ending just over "8h" rather than one
 * running on to an empty "12h"; the next whole step otherwise. Never below one step.
 */
export function stepAxisMax(max: number, step: number): number {
  const top = Math.max(1, Math.ceil(max / step)) * step
  const below = top - step
  return below > 0 && max - below <= step / 4 ? max : top
}
