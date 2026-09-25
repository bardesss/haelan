import type { PersonQuery } from './personQuery.ts'
import { requireDate } from './personQuery.ts'
import type { Baseline } from './baseline.ts'
import { standingOf } from './glance.ts'
import type { GlanceBaseline } from './glance.ts'
import { ConfigError } from '../errors.ts'

/**
 * The calendar's two verdicts (M9c spec, "Server and data"): sleep is judged against the night's
 * own baseline, `outside` covering both a night above and below it; steps is judged against the
 * day's, `below` kept apart from `reached` because a day that fell short of its usual is the one
 * thing the calendar exists to flag at a glance.
 */
export type CalendarSleep = 'within' | 'outside' | null
export type CalendarSteps = 'reached' | 'below' | null

export interface GlanceCalendarDay {
  localDate: string
  sleep: CalendarSleep
  steps: CalendarSteps
}

export interface GlanceCalendar {
  month: string
  /** The earliest local date anywhere in the archive with data, never just this month's. Null when the person has none at all. */
  firstDay: string | null
  days: GlanceCalendarDay[]
}

/**
 * The unrounded shape a day needs before a verdict can be judged: the two values and the two
 * bands `judgeCalendarDay` reads, plus whether the steps figure is still running. Exported
 * because the HTTP route (M9c) rounds these to catalogue precision - as it already does for
 * every other figure in `/glance` - before calling `judgeCalendarDay`, so a value that only
 * clears its band before rounding cannot disagree with the dots a person is actually shown.
 */
export interface RawCalendarDay {
  localDate: string
  sleepValue: number | null
  sleepBand: GlanceBaseline | null
  stepsValue: number | null
  stepsBand: GlanceBaseline | null
  /** True only for today: its steps total is still running, never a finished day in the same month. */
  stepsPartial: boolean
}

export interface GlanceCalendarRaw {
  month: string
  firstDay: string | null
  days: RawCalendarDay[]
}

/**
 * The pure judgement (M9c spec): sleep never partial (a night is complete by the time it has a
 * derived row at all); steps carries `stepsPartial`, which is what makes today's own steps `null`
 * rather than a verdict against a day that has not finished. `standingOf` already collapses "no
 * value", "no or thin band" and "partial" into one null, so this only has to fold its two
 * non-null outcomes onto the calendar's own words.
 */
export function judgeCalendarDay(raw: RawCalendarDay): GlanceCalendarDay {
  const sleepStanding = standingOf(raw.sleepValue, raw.sleepBand, false)
  const stepsStanding = standingOf(raw.stepsValue, raw.stepsBand, raw.stepsPartial)
  return {
    localDate: raw.localDate,
    sleep: sleepStanding === null ? null : sleepStanding === 'within' ? 'within' : 'outside',
    steps: stepsStanding === null ? null : stepsStanding === 'below' ? 'below' : 'reached',
  }
}

const MONTH_RE = /^\d{4}-\d{2}$/

function requireMonth(label: string, value: string, today: string): void {
  if (!MONTH_RE.test(value)) {
    throw new ConfigError(`${label} must be a YYYY-MM month, got '${value}'`)
  }
  const monthNumber = Number(value.slice(5, 7))
  if (monthNumber < 1 || monthNumber > 12) {
    throw new ConfigError(`${label} must be a YYYY-MM month, got '${value}'`)
  }
  if (value > today.slice(0, 7)) {
    throw new ConfigError(`${label} '${value}' is after the current month`)
  }
}

/** Whether `year` is a leap year on the Gregorian calendar, the one fact `monthEndOf` needs from a real calendar library. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * The last local date of `month` (YYYY-MM), by plain integer arithmetic rather than `Date`: a
 * `Date` built from a month string is parsed in either UTC or the host's own zone depending on
 * how it is spelled, and a calendar day is not an instant in either.
 */
function monthEndOf(month: string): string {
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const days = monthNumber === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[monthNumber - 1]!
  return `${month}-${String(days).padStart(2, '0')}`
}

/** One place turns a query's baseline into the band `judgeCalendarDay` reads (same shape `glance.ts`'s own `toGlanceBaseline` builds). */
function toBand(baseline: Baseline | null): GlanceBaseline | null {
  return baseline === null ? null : {
    center: baseline.center, low: baseline.center - baseline.spread, high: baseline.center + baseline.spread, thin: baseline.thin,
  }
}

/**
 * The calendar's raw reader (M9c spec, "Server and data"): every local date in `month` (up to
 * `today`, for the current month) that has a glance-day row, each with its unrounded sleep and
 * steps values and bands. `firstDay` is the earliest day with data anywhere in the archive, which
 * is why it is computed once here rather than filtered out of `days`: a month with a gap at its
 * own start must not be mistaken for the start of the archive.
 *
 * Bounded reads throughout: one `daysWithData` call, one `series` call per metric over the whole
 * month, and one `baseline` call per metric per day the month actually has data for (at most
 * 31 x 2 = 62 reads of at most 60 rows each) - never a query inside a per-row loop.
 */
export function readGlanceCalendarRaw(q: PersonQuery, input: { month: string, today: string }): GlanceCalendarRaw {
  requireDate('today', input.today)
  requireMonth('month', input.month, input.today)

  const monthStart = `${input.month}-01`
  const monthEnd = monthEndOf(input.month)
  const to = monthEnd < input.today ? monthEnd : input.today

  const firstDay = q.nearestDayWithData({ on: '0000-01-01', direction: 'after' })

  const dates = q.daysWithData({ from: monthStart, to })
  if (dates.length === 0) return { month: input.month, firstDay, days: [] }

  const stepsByDate = new Map(q.series({ metric: 'steps', agg: 'sum', from: monthStart, to }).points.map((p) => [p.localDate, p.value]))
  const sleepByDate = new Map(q.series({ metric: 'sleep_asleep_minutes', agg: 'sum', from: monthStart, to }).points.map((p) => [p.localDate, p.value]))

  const days = dates.map((localDate): RawCalendarDay => ({
    localDate,
    sleepValue: sleepByDate.get(localDate) ?? null,
    sleepBand: toBand(q.baseline({ metric: 'sleep_asleep_minutes', agg: 'sum', on: localDate })),
    stepsValue: stepsByDate.get(localDate) ?? null,
    stepsBand: toBand(q.baseline({ metric: 'steps', agg: 'sum', on: localDate })),
    stepsPartial: localDate === input.today,
  }))

  return { month: input.month, firstDay, days }
}

/**
 * The calendar (M9c): a month of days with data, each with its sleep and steps verdicts, for the
 * dashboard's calendar picker. Unrounded, like every other core reader - the HTTP route rounds to
 * catalogue precision and re-judges from those rounded numbers via `readGlanceCalendarRaw` and
 * `judgeCalendarDay` directly, the same split `/glance` already keeps between core and the wire.
 */
export function readGlanceCalendar(q: PersonQuery, input: { month: string, today: string }): GlanceCalendar {
  const raw = readGlanceCalendarRaw(q, input)
  return { month: raw.month, firstDay: raw.firstDay, days: raw.days.map(judgeCalendarDay) }
}
