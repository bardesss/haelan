import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import {
  withinSchedule, localMinutesOf, inWindow, napInWindow, noDataYFor, axisTickInterval,
  fitWindow, MIN_FITTED_SPAN,
  AXIS_MIN, AXIS_MAX, DEFAULT_WINDOW, WIDE_WINDOW,
} from '../src/charts/schedule.js'

// The pure home for the bed/wake window arithmetic both SleepSchedule callers (Dashboard.tsx via
// sleep_bedtime_minutes/sleep_waketime_minutes, Sleep.tsx via the same two metrics since the
// contamination fix) go through. This is the one part of the chart that is NOT behind canvas:
// echarts draws to an SVG host happy-dom applies no stylesheet to, so a component test can see the
// accessible table a chart renders but never the span itself, which is exactly how a previous
// round of this task shipped a schedule chart that silently drew a 26 hour night as a 2 hour bar.
// Pinning the arithmetic itself here is what catches that regardless of which page renders it.

describe('withinSchedule', () => {
  // 23:20 to 07:05: the ordinary case, a bedtime before midnight and a wake time after it. bedRaw
  // and wakeRaw are the raw sleep_bedtime_minutes/sleep_waketime_minutes convention directly
  // (minutes from the wake day's local midnight, negative before it - "an 23:30 bedtime is -30",
  // packages/core/src/derive/metrics.ts), the same numbers localMinutesOf would derive from a
  // Night's own timestamps.
  it('draws a normal night, unaffected by which window it is measured against', () => {
    const bedRaw = -40
    const wakeRaw = 425
    for (const window of [DEFAULT_WINDOW, WIDE_WINDOW]) {
      const { bed, wake } = withinSchedule(bedRaw, wakeRaw, window)
      expect(bed).toBe(1400) // 23:20
      expect(wake).toBe(1865) // 07:05 the next day, on this axis's own frame
      expect(wake! - bed!).toBe(wakeRaw - bedRaw) // the true 7h45m duration, preserved exactly
    }
  })

  // 20:00 to 12:00: 16 hours, the case this task was written for. It lands exactly on the default
  // window's own top gridline (2160) once the duration is computed correctly, which the inclusive
  // upper bound (matching Dashboard's own check) accepts under the DEFAULT window too. An earlier
  // draft of this fix used an exclusive upper bound specifically so this case would only pass under
  // a widened window, which manufactured the falsifiability the task wanted rather than
  // demonstrating it; the honest finding is that the duration fix rescues this exact night on its
  // own, and the wider window earns its place on a longer span instead (see the 26 hour cases
  // below).
  it('draws a sixteen hour night under the default window once the duration math is right', () => {
    const bedRaw = -240
    const wakeRaw = 720
    for (const window of [DEFAULT_WINDOW, WIDE_WINDOW]) {
      const { bed, wake } = withinSchedule(bedRaw, wakeRaw, window)
      expect(bed).toBe(1200) // 20:00
      expect(wake).toBe(2160) // 12:00, a full day on from bed's own frame
      expect(wake! - bed!).toBe(960) // 16 hours
    }
  })

  // 13:00 to 17:00: a daytime-only span, no midnight crossed. Neither end needs a day added
  // (both already read past the window's own noon on their own), and neither window changes the
  // result: this is exactly the case AXIS_MIN sits at noon rather than midnight for ("naps at
  // 13:00 fit without compressing the sleep band").
  it('draws a daytime-only span the same under either window', () => {
    const bedRaw = 780
    const wakeRaw = 1020
    for (const window of [DEFAULT_WINDOW, WIDE_WINDOW]) {
      const { bed, wake } = withinSchedule(bedRaw, wakeRaw, window)
      expect(bed).toBe(780) // 13:00
      expect(wake).toBe(1020) // 17:00
      expect(wake! - bed!).toBe(240) // 4 hours
    }
  })

  // 20:00 to 22:00 the next day: 26 hours. This is the shape a previous round of this task drew
  // wrong: an independent per-value shift left wake (22:00, already past the window's own noon)
  // unshifted, which read as "already correctly placed" and produced a false 2 hour span instead
  // of an honest absence or a true 26 hour bar. readSleepNights makes this reachable in practice
  // (a night grouped with a late evening session sharing the wake date), not merely theoretical.
  it('suppresses a 26 hour night as no data under the default window, rather than drawing it short', () => {
    const bedRaw = -240 // 20:00 the day before
    const wakeRaw = 1320 // 22:00
    const { bed, wake } = withinSchedule(bedRaw, wakeRaw, DEFAULT_WINDOW)
    expect(bed).toBeNull()
    expect(wake).toBeNull()
  })

  it('draws the same 26 hour night under the wide window, at its true length', () => {
    const bedRaw = -240
    const wakeRaw = 1320
    const { bed, wake } = withinSchedule(bedRaw, wakeRaw, WIDE_WINDOW)
    expect(bed).toBe(1200) // 20:00
    expect(wake).toBe(2760) // 22:00, two days on from bed's own frame
    expect(wake! - bed!).toBe(1560) // 26 hours, not the 120 minutes the old algorithm drew
  })

  // The general form of the regression above, not just its one instance: whenever a span is drawn
  // at all, the drawn duration must equal the true one, for every duration from a short nap up
  // through a span long enough that only the wide window can hold it. This is what the retry based
  // algorithm this file replaced could not promise, since its correctness depended on whether wake
  // happened to read past the window's own noon on its own, not on the actual length of the night.
  it.each([
    ['15 minutes', -10, 5],
    ['a normal night', -40, 425],
    ['exactly 16 hours', -240, 720],
    ['16 hours 5 minutes, one axis-minute past the default window boundary', -240, 725],
    ['24 hours 30 minutes', -240, 1230],
    ['26 hours', -240, 1320],
  ] as const)('preserves the true duration for %s wherever it draws', (_label, bedRaw, wakeRaw) => {
    for (const window of [DEFAULT_WINDOW, WIDE_WINDOW]) {
      const { bed, wake } = withinSchedule(bedRaw, wakeRaw, window)
      if (bed === null || wake === null) continue // out of this window's range: an honest absence, not a wrong number
      expect(wake - bed).toBe(wakeRaw - bedRaw)
    }
  })

  it('nulls out a night with no bed or no wake reading, the ordinary absence case', () => {
    expect(withinSchedule(null, 425, DEFAULT_WINDOW)).toEqual({ bed: null, wake: null })
    expect(withinSchedule(-40, null, DEFAULT_WINDOW)).toEqual({ bed: null, wake: null })
  })

  it('nulls out a wake reading that is not after its own bed reading, a malformed pair rather than a night', () => {
    expect(withinSchedule(100, 100, DEFAULT_WINDOW)).toEqual({ bed: null, wake: null })
    expect(withinSchedule(100, 50, DEFAULT_WINDOW)).toEqual({ bed: null, wake: null })
  })
})

describe('localMinutesOf', () => {
  // The same night as the "normal" case above, derived from real timestamps rather than handed
  // the already-computed minutes: the hypnogram's bed label and (before the contamination fix) an
  // earlier version of the schedule chart both derive bedRaw/wakeRaw this way from a Night's own
  // startMs/endMs, so this is the one piece of real millisecond arithmetic worth pinning on its
  // own.
  it('reads a negative bedtime for a night starting before the wake date\'s own midnight', () => {
    const wakeDate = '2026-08-15'
    const wakeMidnight = Date.parse(`${wakeDate}T00:00:00Z`)
    const startMs = wakeMidnight - 40 * 60_000 // 23:20 the day before
    expect(localMinutesOf(wakeDate, startMs, 0)).toBe(-40)
  })

  it('reads a positive wake time on the wake date itself', () => {
    const wakeDate = '2026-08-15'
    const wakeMidnight = Date.parse(`${wakeDate}T00:00:00Z`)
    const endMs = wakeMidnight + 425 * 60_000 // 07:05
    expect(localMinutesOf(wakeDate, endMs, 0)).toBe(425)
  })
})

describe('inWindow', () => {
  it('leaves a reading already past the window\'s own noon alone', () => {
    expect(inWindow(780, DEFAULT_WINDOW)).toBe(780) // 13:00
  })

  it('adds a day to a reading before the window\'s own noon', () => {
    expect(inWindow(-40, DEFAULT_WINDOW)).toBe(1400) // 23:20
  })
})

// The function inWindow used to stand in for on the nap side, where it was wrong by a whole day
// for every afternoon nap: a nap is measured from the same midnight a bed/wake pair is, but falls
// after it rather than around it (sessions.localDate is the date a session ENDED), so "before this
// window's noon" is the wrong question to ask of it. Every case below is stated against the same
// night the withinSchedule tests above use, bed -40 and wake 425 placed at 1400 and 1865.
describe('napInWindow', () => {
  it('shifts an afternoon nap into its own night\'s frame, a day right of where inWindow leaves it', () => {
    // 14:30 the same day the night ended: after the 1865 wake, not 24 hours before the 1400 bed.
    expect(napInWindow(870, -40, WIDE_WINDOW)).toBe(2310)
    expect(inWindow(870, WIDE_WINDOW)).toBe(870) // what it used to draw, and why this is not a rewrite of inWindow
  })

  it('keeps the wall clock gap between the wake and the nap exactly what it was', () => {
    const { wake } = withinSchedule(-40, 425, WIDE_WINDOW)
    // 07:05 to 14:30 is 7h25m, and the nap has to land that far right of the wake, not 16h35m
    // left of it, which is what an unshifted 870 against an 1865 wake reads as.
    expect(napInWindow(870, -40, WIDE_WINDOW) - wake!).toBe(870 - 425)
  })

  // A morning nap is the case the old code happened to get right, which is why the naps column
  // test could not see the defect: it needs the same day added, and gets it here too.
  it('places a morning nap the same way, rather than only fixing the afternoon', () => {
    expect(napInWindow(600, -40, WIDE_WINDOW)).toBe(2040) // 10:00
  })

  it('takes the shift from the wake time when no bedtime answered for the row', () => {
    expect(napInWindow(870, 425, WIDE_WINDOW)).toBe(2310)
  })

  // The shift is the night's, not a constant: a row whose whole span sat on the wake date itself
  // (20:00 to 22:00, which withinSchedule leaves unshifted at 1200 and 1320) needs its nap left
  // unshifted too, or the marker lands a day right of the bar instead of a day left of it.
  it('leaves a nap unshifted on a row whose own night was never shifted', () => {
    const { bed } = withinSchedule(20 * 60, 22 * 60, WIDE_WINDOW)
    expect(bed).toBe(1200)
    expect(napInWindow(870, 20 * 60, WIDE_WINDOW)).toBe(870)
  })

  // The ordinary shift, taken by every row with no placeable night of its own: those rows draw an
  // absence dot rather than a span, and their naps are still real times of day.
  it('falls back to a day for a row with neither a bedtime nor a wake time', () => {
    expect(napInWindow(870, null, WIDE_WINDOW)).toBe(2310)
  })

  // Under that ordinary shift the wide window is wide enough for any nap the clock can produce,
  // which is the claim napInWindow's own comment makes about not clamping.
  it('keeps every shifted nap inside the wide window a nap-drawing caller passes', () => {
    for (const raw of [0, 1, 720, 1200, 1439]) {
      const placed = napInWindow(raw, -40, WIDE_WINDOW)
      expect(placed).toBeGreaterThanOrEqual(WIDE_WINDOW.min)
      expect(placed).toBeLessThanOrEqual(WIDE_WINDOW.max)
    }
  })
})

describe('noDataYFor', () => {
  it('sits 60 minutes below the top of whichever window it is given', () => {
    expect(noDataYFor(DEFAULT_WINDOW)).toBe(AXIS_MAX - 60)
    expect(noDataYFor(WIDE_WINDOW)).toBe(WIDE_WINDOW.max - 60)
  })

  it('moves with a wider window rather than staying pinned to the default one', () => {
    expect(noDataYFor(WIDE_WINDOW)).toBeGreaterThan(noDataYFor(DEFAULT_WINDOW))
  })

  it('keeps AXIS_MIN and the default window in the shape every caller assumes', () => {
    expect(DEFAULT_WINDOW).toEqual({ min: AXIS_MIN, max: AXIS_MAX })
  })
})

// The y-axis defect final-review.md reported and reproduced live: labels reading
// 12:00|16:00|01:00|09:00|17:00|00:00 bottom to top, not monotonic, with the bottom two
// overlapping. ECharts's own automatic tick search for a value axis chose an interval without
// regard to whether it divided AXIS_MIN..AXIS_MAX evenly, so one tick landed however far short
// of a full interval its neighbour happened to leave. axisTickInterval replaces that search with
// an explicit interval; these are the properties an axis built from it has to hold for every
// window this app actually passes, not just the two numbers below.
describe('axisTickInterval', () => {
  it('divides the default noon-to-noon window into four-hour ticks', () => {
    expect(axisTickInterval(DEFAULT_WINDOW)).toBe(4 * 60)
  })

  it('divides the wide window into six-hour ticks, not the default window\'s four', () => {
    expect(axisTickInterval(WIDE_WINDOW)).toBe(6 * 60)
  })

  it('divides both windows\' own span exactly, leaving no leftover gap at the top boundary', () => {
    // The defect itself: an interval that does not divide the span evenly leaves the tick
    // nearest one boundary closer to its neighbour than every other pair, which is what
    // overlapped in the reported screenshot. This is the property this function has to hold,
    // not merely the two concrete values above.
    for (const window of [DEFAULT_WINDOW, WIDE_WINDOW]) {
      expect((window.max - window.min) % axisTickInterval(window)).toBe(0)
    }
  })

  it('steps the clock reading forward by exactly one interval a tick, or back by one interval minus a day at a genuine midnight crossing, and never anything else', () => {
    for (const window of [DEFAULT_WINDOW, WIDE_WINDOW]) {
      const interval = axisTickInterval(window)
      const ticks: number[] = []
      for (let v = window.min; v <= window.max; v += interval) ticks.push(v)
      // Not vacuous: a window whose span happened to be shorter than one interval would let the
      // loop below run zero times and pass without checking anything.
      expect(ticks.length).toBeGreaterThan(2)
      const clockOf = (v: number) => ((v % 1440) + 1440) % 1440
      for (let i = 1; i < ticks.length; i++) {
        const delta = clockOf(ticks[i]!) - clockOf(ticks[i - 1]!)
        // This is exactly what the reported sequence broke: 17:00 to 09:00 is neither +interval
        // nor a wrapped -interval, it is a jump the axis's own reader has no clock reading for.
        expect([interval, interval - 1440]).toContain(delta)
      }
    }
  })
})

// The claim at the top of this file, checked rather than asserted in prose. A page that renders
// SleepSchedule and works out its own bed/wake placement is invisible to every other test here:
// echarts draws to canvas, so a wrong span renders silently, and the arithmetic tested above only
// protects the callers that actually reach it. Dashboard.tsx kept its own untested copy through
// the whole of the task that moved Sleep.tsx across, in the pre fix independently shifted form,
// which is the regression this guards.
// Every read happens inside the test rather than in the describe body, which vitest runs at
// collection time. A root relative path read during collection throws before any test exists, so a
// run from a different working directory took this whole file down, arithmetic assertions and all,
// instead of failing the one guard that actually depends on the filesystem. The rest of this file
// is pure and has no reason to share that fate.
//
// One test looping rather than it.each over the discovered files, for the same reason: it.each
// needs its cases enumerated at collection time, which is the read this is moving. Each assertion
// names the page it is about, so a failure still says which file is wrong.
describe('every SleepSchedule caller goes through this module', () => {
  it('imports the schedule arithmetic in every page that renders the chart, rather than redeclaring it', () => {
    const dir = 'apps/web/src/pages'
    const sources = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => [file, readFileSync(`${dir}/${file}`, 'utf8')] as const)
    const callers = sources.filter(([, source]) => /<SleepSchedule[\s>]/.test(source))
    // At least one, so the sweep cannot pass by matching nothing: a regex that stopped matching
    // would otherwise look like agreement. It was more than one until M9b, when the Dashboard's
    // copy of the sleep schedule card left with the old page and Sleep.tsx became the only caller.
    expect(callers.length).toBeGreaterThanOrEqual(1)
    for (const [page, source] of callers) {
      expect(source, page).toMatch(/from '\.\.\/charts\/schedule\.js'/)
      // A local declaration of any of the three, not a mere mention: the names appear in prose in
      // several of these files, and a comment naming withinSchedule proves nothing either way.
      expect(source, page).not.toMatch(/(?:function|const)\s+(?:localMinutesOf|inWindow|withinSchedule)\b/)
    }
  })
})

/**
 * An axis fitted to the nights it has to draw, rather than a constant.
 *
 * DEFAULT_WINDOW reserves noon to noon so that a nap at 13:00 fits without compressing the sleep
 * band - which is right for the caller that draws naps and pure cost for the one that does not.
 * Measured against a real archive, a third of that axis sat permanently empty below the earliest
 * bedtime, which is why the bars read as thin floating ticks: ten hours of data stretched over
 * twenty-four.
 *
 * Fitted rather than narrowed to a better constant, and that is the load-bearing choice. Every
 * candidate constant placed every night in the archive it was measured against, so a constant
 * would have looked perfect - and it would have been tuned to one household's hours. A shift
 * worker sleeping at 09:00 falls outside it, and withinSchedule does not complain when a night
 * falls outside a window: it nulls the night out, and SleepSchedule draws an absence dot. The
 * failure would look like missing data rather than a bad axis.
 */
describe('fitWindow', () => {
  // 23:30 to 07:00, in the minutes-from-local-midnight convention where a bedtime before midnight
  // is negative.
  const night = (bed: number, wake: number) => ({ bed, wake })

  it('brackets the nights it is given', () => {
    const fitted = fitWindow([night(-30, 420)])
    // The bed is drawn at 1410 (23:30 the evening before) and the wake at 1860 (07:00).
    expect(fitted.min).toBeLessThanOrEqual(1410)
    expect(fitted.max).toBeGreaterThanOrEqual(1860)
  })

  it('lands on whole hours, so the tick labels stay whole hours', () => {
    const fitted = fitWindow([night(-37, 433)])
    expect(fitted.min % 60).toBe(0)
    expect(fitted.max % 60).toBe(0)
  })

  it('places every night it fitted itself to', () => {
    // The property that matters, and the one a constant cannot promise: a window derived from
    // these nights must never be a window that then refuses one of them.
    const nights = [night(-236, 266), night(-30, 420), night(276, 652)]
    const fitted = fitWindow(nights)
    for (const n of nights) {
      expect(withinSchedule(n.bed, n.wake, fitted).bed, `${n.bed}/${n.wake}`).not.toBeNull()
    }
  })

  it('is at least a readable span when one short night is all there is', () => {
    const fitted = fitWindow([night(-30, 60)])
    expect(fitted.max - fitted.min).toBeGreaterThanOrEqual(MIN_FITTED_SPAN)
  })

  it('falls back to the default window when there is nothing to fit to', () => {
    expect(fitWindow([])).toEqual(DEFAULT_WINDOW)
  })

  // A night withinSchedule refuses outright - wake at or before bed, which is how a session longer
  // than the frame arrives - must not drag the axis with it. It is drawn as an absence dot and the
  // window has nothing to learn from it.
  it('ignores a night that cannot be placed at all', () => {
    const fitted = fitWindow([night(-30, 420), night(500, 100)])
    expect(fitted).toEqual(fitWindow([night(-30, 420)]))
  })

  it('keeps a late sleeper inside the axis rather than dropping them off it', () => {
    // 09:00 to 17:00, which DEFAULT_WINDOW cannot place: the whole reason this is fitted.
    const shiftWorker = night(540, 1020)
    expect(withinSchedule(shiftWorker.bed, shiftWorker.wake, DEFAULT_WINDOW).bed).toBeNull()
    const fitted = fitWindow([shiftWorker])
    expect(withinSchedule(shiftWorker.bed, shiftWorker.wake, fitted).bed).not.toBeNull()
  })

  // Six equal whole-hour steps is what axisTickInterval draws, so a span that is not a multiple of
  // six hours leaves the last gap short: the uneven end tick that function exists to prevent.
  it('spans a whole number of six hour blocks, so every tick gap is equal', () => {
    for (const nights of [[night(-30, 420)], [night(-37, 433)], [night(-236, 266), night(276, 652)], [night(-30, 60)]]) {
      const fitted = fitWindow(nights)
      const span = fitted.max - fitted.min
      expect(span % 360, JSON.stringify(nights)).toBe(0)
      expect(span % axisTickInterval(fitted)).toBe(0)
    }
  })

  // Naps arrive already placed by napInWindow, in the frame the nights were placed in. The Sleep
  // page draws them, so an axis fitted to the nights alone would clip the afternoon nap it shows.
  it('reaches an afternoon nap when naps are drawn, and ignores it when they are not', () => {
    // 23:30 to 07:00, then a nap at 15:00 the same day: placed at 1440 + 900.
    const withNap = [{ bed: -30, wake: 420, naps: [2340] }]
    expect(fitWindow(withNap, { naps: true }).max).toBeGreaterThanOrEqual(2340)
    expect(fitWindow(withNap).max).toBeLessThan(2340)
  })

  it('stays within a day for an ordinary night and its afternoon nap, so no label repeats', () => {
    const fitted = fitWindow([{ bed: -30, wake: 420, naps: [2340] }], { naps: true })
    expect(fitted.max - fitted.min).toBeLessThanOrEqual(1440)
  })
})
