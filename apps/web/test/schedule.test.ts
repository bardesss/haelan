import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import {
  withinSchedule, localMinutesOf, inWindow, noDataYFor, AXIS_MIN, AXIS_MAX, DEFAULT_WINDOW, WIDE_WINDOW,
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

// The claim at the top of this file, checked rather than asserted in prose. A page that renders
// SleepSchedule and works out its own bed/wake placement is invisible to every other test here:
// echarts draws to canvas, so a wrong span renders silently, and the arithmetic tested above only
// protects the callers that actually reach it. Dashboard.tsx kept its own untested copy through
// the whole of the task that moved Sleep.tsx across, in the pre fix independently shifted form,
// which is the regression this guards.
describe('every SleepSchedule caller goes through this module', () => {
  const PAGES = 'apps/web/src/pages'
  const pages = readdirSync(PAGES).filter((f) => f.endsWith('.tsx'))
  const sources = new Map(pages.map((page) => [page, readFileSync(`${PAGES}/${page}`, 'utf8')]))
  const callers = pages.filter((page) => /<SleepSchedule[\s>]/.test(sources.get(page)!))

  it.each(callers)('%s imports the schedule arithmetic rather than redeclaring it', (page) => {
    const source = sources.get(page)!
    expect(source).toMatch(/from '\.\.\/charts\/schedule\.js'/)
    // A local declaration of any of the three, not a mere mention: the names appear in prose in
    // several of these files, and a comment naming withinSchedule proves nothing either way.
    expect(source).not.toMatch(/(?:function|const)\s+(?:localMinutesOf|inWindow|withinSchedule)\b/)
  })

  it('finds the callers it claims to check', () => {
    expect(callers.length).toBeGreaterThan(1)
  })
})
