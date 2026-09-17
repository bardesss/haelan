import type { ChartTokens } from './tokens.js'

export type Night = { date: string; bed: number | null; wake: number | null; naps: number[] }

export type NightMark =
  | { kind: 'no-data'; color: string }
  | { kind: 'span'; bed: number; wake: number; color: string }

export function nightMark(night: Night, t: ChartTokens): NightMark {
  if (night.bed === null || night.wake === null) return { kind: 'no-data', color: t.noData }
  return { kind: 'span', bed: night.bed, wake: night.wake, color: t.stageLight }
}

// Noon to noon: shifted rather than widened, so naps at 13:00 fit without compressing the sleep
// band. SleepSchedule's own default axis, and the window every caller measures against unless it
// passes its own.
export const AXIS_MIN = 12 * 60
export const AXIS_MAX = 36 * 60
export const DEFAULT_WINDOW = { min: AXIS_MIN, max: AXIS_MAX }

/**
 * The narrowest axis worth drawing, in minutes.
 *
 * Twelve hours. A single short night would otherwise fit itself an axis two hours tall, where the
 * bar fills the plot and the gridlines sit minutes apart - technically the tightest fit and
 * useless to read. This is the floor below which a fitted window stops tightening, not a target.
 */
export const MIN_FITTED_SPAN = 12 * 60

/**
 * An axis fitted to the nights it has to draw.
 *
 * DEFAULT_WINDOW reserves noon to noon so a nap at 13:00 fits without compressing the sleep band,
 * which is right for the caller that draws naps and pure cost for the one that does not. Measured
 * against a real archive, a third of that axis sat permanently empty below the earliest bedtime -
 * which is why the bars read as thin floating ticks rather than as spans.
 *
 * Fitted rather than narrowed to a better constant, and that is the load-bearing choice. Every
 * candidate constant placed every night of the archive it was measured against, so a constant
 * would have looked perfect and would have been tuned to one household's hours. Somebody who
 * sleeps days falls outside it, and `withinSchedule` does not complain when a night falls outside
 * its window: it nulls the night out and the chart draws an absence dot. The failure would read as
 * missing data rather than as a wrong axis, which is the worst way for it to fail.
 *
 * Whole hours out, because `axisTickInterval` divides the span into six and a window ending at
 * 23:47 gives six ticks nobody can read.
 */
export function fitWindow(
  nights: readonly { bed: number | null, wake: number | null }[],
): { min: number, max: number } {
  let low = Infinity
  let high = -Infinity

  for (const night of nights) {
    if (night.bed === null || night.wake === null || night.wake <= night.bed) continue
    // The same frame shift withinSchedule applies, so the bounds are in the coordinates the spans
    // will actually be drawn in. A window derived from anything else would be a window that then
    // refuses the nights it came from.
    const bed = inWindow(night.bed, DEFAULT_WINDOW)
    const wake = bed + (night.wake - night.bed)
    if (bed < low) low = bed
    if (wake > high) high = wake
  }

  // Nothing placeable to learn from: a range with no nights, or only nights withinSchedule refuses
  // outright. The default window is as good an empty axis as any, and it keeps the tick labels a
  // reader may already recognise.
  if (low === Infinity) return DEFAULT_WINDOW

  let min = Math.floor(low / 60) * 60
  let max = Math.ceil(high / 60) * 60
  // Grown from the middle so a short range stays centred rather than hanging off one edge.
  const short = MIN_FITTED_SPAN - (max - min)
  if (short > 0) {
    min -= Math.floor(short / 2 / 60) * 60
    max += Math.ceil(short / 2 / 60) * 60
  }
  return { min, max }
}

// A further noon two days on rather than one: wide enough that a night running past the default
// window's own noon sits inside it instead of on its edge or past it. Sleep.tsx's own schedule
// card passes this; Dashboard's stays on DEFAULT_WINDOW. Exported here rather than declared on the
// page that uses it, once schedule-marks.test.ts needed the same numbers to pin the no-data dot's
// clearance under it too.
export const WIDE_WINDOW = { min: AXIS_MIN, max: AXIS_MIN + 36 * 60 }

// 60 minutes below the top of whichever window is in force, not a fixed point tied to the default
// window alone: parked clear of every real span the window can draw (schedule-marks.test.ts pins
// the clearance) without reading as a plausible time itself. A caller passing WIDE_WINDOW gets its
// own dot near that window's own top, not one sitting well inside the band where a real wide
// window span can now legitimately be.
const NO_DATA_MARGIN = 60

export function noDataYFor(window: { min: number, max: number }): number {
  return window.max - NO_DATA_MARGIN
}

const MINUTES_PER_HOUR = 60

/**
 * SleepSchedule's own y-axis tick spacing, in minutes: six equal, whole-hour intervals across
 * whichever window a caller passes, rather than ECharts's default value-axis tick search, which
 * this replaced. That search picks a "nice" interval from the axis's overall range without regard
 * to where the caller's own min and max actually sit, so the tick nearest each boundary lands
 * whatever distance short of it the interval happens to leave, not a whole interval away like
 * every other gap - which is what put an unevenly spaced tick, and its overlapping label, at one
 * end of the axis (reproduced live: `12:00|16:00|01:00|09:00|17:00|00:00`, not monotonic and not
 * evenly spaced). Six is not a magic tick count so much as the number that happens to land on a
 * whole hour for both windows this app actually builds - DEFAULT_WINDOW's 24 hour span becomes
 * four-hour ticks, WIDE_WINDOW's 36 hour span becomes six-hour ticks - so both read at the same
 * density, seven labels evenly spaced in the same 150px chart, rather than the wider window
 * buying itself more ticks than that height has room to draw without them touching.
 *
 * This does not remove the axis's wrap-around: a noon-to-noon window genuinely does cross
 * midnight, and an evenly spaced tick either side of it will always read as a large apparent drop
 * (23:xx down to 00:xx) because that is what the clock actually does there. What this removes is
 * every OTHER tick reading like that - the defect was never the wrap itself, it was ECharts
 * picking tick positions this axis's own formatter (`formatClock`, wrapping every 1440 minutes)
 * was never consulted about.
 */
export function axisTickInterval(window: { min: number, max: number }): number {
  const spanHours = (window.max - window.min) / MINUTES_PER_HOUR
  return Math.round(spanHours / 6) * MINUTES_PER_HOUR
}

// The default window's own no-data Y, named for callers (and schedule-marks.test.ts's own
// pre-existing assertions) that only ever draw the default window.
export const NO_DATA_Y = noDataYFor(DEFAULT_WINDOW)

// Minutes from the local midnight of `localDate`, negative before it: the convention
// packages/core/src/derive/localDay.ts sets and sleep_bedtime_minutes/sleep_waketime_minutes are
// stored in ("an 23:30 bedtime is -30", packages/core/src/derive/metrics.ts). Also how a caller
// reading /sleep/nights directly (Sleep.tsx's own hypnogram bed label) derives the same figure
// from a Night's timestamps, which carry no pre-computed minutes value of their own.
export function localMinutesOf(localDate: string, utcMs: number, offsetMinutes: number): number {
  const wall = utcMs + offsetMinutes * 60_000
  return Math.round((wall - Date.parse(`${localDate}T00:00:00Z`)) / 60_000)
}

// Shifts a single minutes-from-midnight reading into the window's own day: a reading already past
// the window's own noon is a same day daytime reading and is left alone; anything earlier is the
// wake day's small hours and needs a day added to land after the previous noon instead. Used on
// its own for a single reading (a hypnogram's bed label); withinSchedule below is what a bed/wake
// pair goes through, and does not call this on the wake side (see its own comment for why).
export function inWindow(minutes: number, window: { min: number, max: number }): number {
  return minutes < window.min ? minutes + 1440 : minutes
}

/**
 * Where a nap taken on a row's own local date lands on that row's axis.
 *
 * inWindow is the wrong tool for it, and the difference is a whole day. A bed or wake reading is
 * measured from the midnight the night is named after and sits in [-720, 720), so inWindow's own
 * rule ("earlier than this window's noon means the small hours of the wake day") is true of it. A
 * nap is measured from that same midnight but falls on the far side of it: sessions.localDate is
 * the date a session ENDED (localDateOfEnd, packages/core/src/api/mapSessions.ts), so a nap shares
 * its date with the night's wake and happens after it, and its minutes run 0 to 1440 rather than
 * -720 to 720. Handed to inWindow, an afternoon nap is left exactly where it is while the night
 * beside it was moved a day forward, so it draws 24 hours to the left of the bar it belongs to and
 * reads as a nap taken the afternoon before that bedtime.
 *
 * The nap keeps the row it shares a date with. That row is the one the accessible table already
 * files it under (SleepSchedule's own naps column, keyed on the same n.date), and it is the row
 * whose night ended that morning, so "the night, then the nap that followed it later the same day"
 * is what a reader sees left to right. What changes is the frame: the shift applied is the
 * night's, whatever whole day withinSchedule moved this row's bed by, so the wall clock distance
 * between the wake and the nap is drawn as exactly what it really was. `anchorRaw` is that row's
 * own raw bedtime, or its raw wake time when no bedtime answered; 1440 stands in when the row has
 * neither, which is the shift every night that ended this morning takes anyway.
 *
 * The result is not clamped to the window. Under the ordinary 1440 shift a nap cannot leave
 * WIDE_WINDOW (0 to 1440 becomes 1440 to 2880, its exact top), which is the one window a caller
 * drawing naps passes today; a row whose night was itself an unshifted same-date span can place a
 * nap outside a narrower window, and echarts clips it rather than drawing it somewhere false.
 */
export function napInWindow(
  napRaw: number, anchorRaw: number | null, window: { min: number, max: number },
): number {
  return napRaw + (anchorRaw === null ? 1440 : inWindow(anchorRaw, window) - anchorRaw)
}

// Places a bed/wake pair on the window's axis, or nulls both out if this window cannot show them
// honestly.
//
// An earlier version shifted bed and wake independently (inWindow on each) and retried the shift
// on wake only when the result read backwards (wake <= bed). That passed the one case it was built
// to catch, a night ending exactly at the window's own noon, but was wrong for any session longer
// than 24 hours in a way nothing rendered could show: once a duration over 1440 minutes leaves the
// unshifted wake already reading past the window's own noon, the initial ordering happens to look
// fine on its own, the retry never fires, and the chart draws wake - bed, silently short by however
// many whole days the true span ran past one (a 26 hour night drew as a 2 hour bar; a 24h30 night
// drew as 30 minutes). Not a hypothetical: readSleepNights groups every sleep session sharing a
// local date and source into one row, so a late evening session sharing the wake day's date with
// that morning's own wake becomes exactly this shape.
//
// wakeRaw - bedRaw is the true wall clock duration, exactly: both ends' timezone offsets are
// already folded into bedRaw and wakeRaw by whatever computed them (localMinutesOf, or a
// sleep_waketime_minutes/sleep_bedtime_minutes row already carrying the same convention), and the
// shared local midnight both are measured from cancels out of the subtraction. Shifting bed into
// the window's frame and then adding this untouched duration cannot lose or gain a day regardless
// of how long the span runs or where wake happens to land relative to noon, which is what makes a
// second, guessed shift unnecessary.
export function withinSchedule(
  bedRaw: number | null, wakeRaw: number | null, window: { min: number, max: number },
): { bed: number | null, wake: number | null } {
  if (bedRaw === null || wakeRaw === null || wakeRaw <= bedRaw) return { bed: null, wake: null }
  const bed = inWindow(bedRaw, window)
  const wake = bed + (wakeRaw - bedRaw)
  const inRange = (m: number) => m >= window.min && m <= window.max
  if (!inRange(bed) || !inRange(wake)) return { bed: null, wake: null }
  return { bed, wake }
}
