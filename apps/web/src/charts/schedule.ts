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
