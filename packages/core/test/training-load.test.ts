import { describe, expect, it } from 'vitest'
import {
  ACUTE_DAYS,
  CHRONIC_DAYS,
  MIN_WORN_ACUTE,
  MIN_WORN_CHRONIC,
  trainingLoad,
} from '../src/api/trainingLoad.ts'
import type { LoadDay } from '../src/api/trainingLoad.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'

const END = '2026-09-13'

/** `offset` counts back from END, so 0 is END itself and 27 is the oldest chronic day. */
const on = (offset: number): string => shiftLocalDate(END, -offset)

/** Worn days at `offsets` back from END, each carrying `load`. Absent offsets are unworn. */
function worn(offsets: readonly number[], load: number | ((offset: number) => number)): LoadDay[] {
  return offsets.map((offset) => ({
    localDate: on(offset),
    load: typeof load === 'function' ? load(offset) : load,
  }))
}

const everyDay = Array.from({ length: CHRONIC_DAYS }, (_, index) => index)

describe('trainingLoad', () => {
  it('refuses, and says how far off it is, below the chronic floor', () => {
    const result = trainingLoad(worn(everyDay.slice(0, MIN_WORN_CHRONIC - 1), 10), END)
    expect(result.enough).toBe(false)
    expect(result.wornChronic).toBe(MIN_WORN_CHRONIC - 1)
  })

  it('refuses below the acute floor even when the chronic window is well covered', () => {
    // Three acute days, and every chronic day from the acute window's far side back.
    const offsets = [0, 1, 2, ...everyDay.slice(ACUTE_DAYS)]
    const result = trainingLoad(worn(offsets, 10), END)
    expect(result.enough).toBe(false)
    expect(result.wornAcute).toBe(3)
    expect(result.wornChronic).toBeGreaterThanOrEqual(MIN_WORN_CHRONIC)
  })

  it('counts a worn but sedentary day as worn, and an absent day not at all', () => {
    // Every day worn, but the older two thirds recorded a flat zero.
    const sedentary = trainingLoad(worn(everyDay, (offset) => (offset < ACUTE_DAYS ? 10 : 0)), END)
    expect(sedentary.enough).toBe(true)
    if (!sedentary.enough) return
    expect(sedentary.wornChronic).toBe(CHRONIC_DAYS)

    // The same loads, with the zero days simply missing rather than recorded as zero.
    const absent = trainingLoad(worn(everyDay.slice(0, ACUTE_DAYS), 10), END)
    expect(absent.enough).toBe(false)
    expect(absent.wornChronic).toBe(ACUTE_DAYS)
  })

  it('does not let a wear gap read as rest', () => {
    const full = trainingLoad(worn(everyDay, 10), END)
    // Every other day missing: the same training, half of it unobserved.
    const gapped = trainingLoad(worn(everyDay.filter((offset) => offset % 2 === 0), 10), END)

    expect(full.enough).toBe(true)
    expect(gapped.enough).toBe(true)
    if (!full.enough || !gapped.enough) return
    expect(gapped.acute).toBe(full.acute)
    expect(gapped.chronic).toBe(full.chronic)
    expect(gapped.ratio).toBe(full.ratio)
    expect(gapped.ratio).toBe(1)
  })

  it('reads a hard week against an ordinary month as a ratio above one', () => {
    const result = trainingLoad(worn(everyDay, (offset) => (offset < ACUTE_DAYS ? 20 : 10)), END)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    expect(result.acute).toBe(140)
    // (7 days at 20 plus 21 at 10) / 28, weekly equivalent.
    expect(result.chronic).toBe(87.5)
    expect(result.ratio).toBe(1.6)
    expect(result.target).toBe(result.chronic)
  })

  it('has no ratio when the chronic load is zero, and still reports the loads', () => {
    const result = trainingLoad(worn(everyDay, 0), END)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    expect(result.chronic).toBe(0)
    expect(result.acute).toBe(0)
    expect(result.ratio).toBeNull()
  })

  it('takes the oldest chronic day and leaves the day before it out', () => {
    const inWindow = trainingLoad(worn(everyDay, 10), END)
    const oneTooOld = trainingLoad(
      [...worn(everyDay, 10), { localDate: on(CHRONIC_DAYS), load: 1000 }],
      END,
    )
    expect(inWindow.enough).toBe(true)
    expect(oneTooOld.enough).toBe(true)
    if (!inWindow.enough || !oneTooOld.enough) return
    expect(oneTooOld.chronic).toBe(inWindow.chronic)
    expect(oneTooOld.wornChronic).toBe(CHRONIC_DAYS)
  })

  it('ignores a day after the end of the window', () => {
    const result = trainingLoad(
      [...worn(everyDay, 10), { localDate: shiftLocalDate(END, 1), load: 1000 }],
      END,
    )
    expect(result.enough).toBe(true)
    if (!result.enough) return
    expect(result.acute).toBe(70)
    expect(result.wornChronic).toBe(CHRONIC_DAYS)
  })
})
