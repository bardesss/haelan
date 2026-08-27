import { describe, it, expect } from 'vitest'
import { nightMark, noDataYFor, WIDE_WINDOW } from '../src/charts/schedule.js'
import { AXIS_MIN, AXIS_MAX, NO_DATA_Y } from '../src/charts/SleepSchedule.js'
import { july } from '../src/fixtures/july.js'
import type { ChartTokens } from '../src/charts/tokens.js'

const tokens = {
  stageDeep: '#111111', stageLight: '#222222', stageRem: '#333333', stageAwake: '#444444',
  series: '#555555', grid: '#666666', axis: '#777777', band: '#888888',
  excluded: '#999999', noData: '#aaaaaa', muted: '#bbbbbb', surface: '#cccccc',
} as ChartTokens

describe('night mark selection', () => {
  it('marks a night with no bed time as no-data, coloured with the no-data token', () => {
    const mark = nightMark({ date: '2026-07-05', bed: null, wake: 6 * 60, naps: [] }, tokens)
    expect(mark.kind).toBe('no-data')
    expect(mark.color).toBe(tokens.noData)
  })

  it('marks a night with no wake time as no-data, coloured with the no-data token', () => {
    const mark = nightMark({ date: '2026-07-06', bed: 23 * 60, wake: null, naps: [] }, tokens)
    expect(mark.kind).toBe('no-data')
    expect(mark.color).toBe(tokens.noData)
  })

  it('marks a complete night as a span, coloured with the sleep-stage token', () => {
    const mark = nightMark({ date: '2026-07-07', bed: 23 * 60, wake: 30 * 60, naps: [] }, tokens)
    expect(mark.kind).toBe('span')
    expect(mark.color).toBe(tokens.stageLight)
    if (mark.kind === 'span') {
      expect(mark.bed).toBe(23 * 60)
      expect(mark.wake).toBe(30 * 60)
    }
  })

  it('never uses the same colour for a no-data night and a complete night', () => {
    const noData = nightMark({ date: '2026-07-05', bed: null, wake: null, naps: [] }, tokens)
    const span = nightMark({ date: '2026-07-07', bed: 23 * 60, wake: 30 * 60, naps: [] }, tokens)
    expect(noData.color).not.toBe(span.color)
  })
})

describe('no-data marker placement', () => {
  // Naps included alongside bed and wake: the absence dot must read as "no
  // reading", never as a plausible nap or a plausible bed/wake time.
  const recorded = july.schedule.flatMap((n) => [n.bed, n.wake, ...n.naps].filter((v): v is number => v !== null))

  it('parks the absence dot clear of every real bed time, wake time and nap', () => {
    // Originally placed near the axis floor, it once sat ten minutes below a
    // wake-time cluster spanning 1810 to 1951, which reads as an early morning
    // rather than as a missing night.
    for (const value of recorded) {
      expect(Math.abs(NO_DATA_Y - value), `${value} is too close to the absence dot`).toBeGreaterThan(120)
    }
  })

  it('keeps the absence dot inside the plotted axis', () => {
    expect(NO_DATA_Y).toBeGreaterThan(AXIS_MIN)
    expect(NO_DATA_Y).toBeLessThan(AXIS_MAX)
    expect(AXIS_MAX - NO_DATA_Y).toBeGreaterThanOrEqual(60)
  })
})

describe('no-data marker placement under the wide window', () => {
  // NO_DATA_Y (the default window's own dot, at AXIS_MAX - 60 = 2100) is pinned to the module
  // constants above and cannot see a caller's own window, so a wider window needs its own dot: a
  // previous round of this task widened the axis for Sleep.tsx without moving the dot, which left
  // it 60 minutes from 2160 (the exact wake time a sixteen hour night, 20:00 to 12:00, draws to,
  // and also the default window's own top gridline), half the 120 minute clearance this file
  // otherwise requires. noDataYFor(window) computes the dot from whichever window is actually in
  // force instead.
  const wideNoDataY = noDataYFor(WIDE_WINDOW)

  it('places the wide window\'s own dot at its own top, not the default window\'s', () => {
    expect(wideNoDataY).toBe(WIDE_WINDOW.max - 60)
    expect(wideNoDataY).not.toBe(NO_DATA_Y)
  })

  it('keeps the wide dot a full clearance from 2160, the default window\'s top gridline and a real wake time under the wide one', () => {
    expect(Math.abs(wideNoDataY - 2160)).toBeGreaterThan(120)
  })

  it('keeps the wide dot inside the wide axis, with the same 60 minute margin as the default window', () => {
    expect(wideNoDataY).toBeGreaterThan(WIDE_WINDOW.min)
    expect(wideNoDataY).toBeLessThan(WIDE_WINDOW.max)
    expect(WIDE_WINDOW.max - wideNoDataY).toBeGreaterThanOrEqual(60)
  })

  it('parks the wide dot clear of every bed time, wake time and nap the fixture recorded, the same as the default window', () => {
    const recorded = july.schedule.flatMap((n) => [n.bed, n.wake, ...n.naps].filter((v): v is number => v !== null))
    for (const value of recorded) {
      expect(Math.abs(wideNoDataY - value), `${value} is too close to the wide dot`).toBeGreaterThan(120)
    }
  })
})

describe('every plotted value falls inside the axis domain', () => {
  // Gap 1: the fixture's naps (13:00-16:00, minutes 780-960) fell below the
  // chart's old axis minimum of 18:00 (1080), so ECharts silently clipped
  // every one of them even though both reference pages claim "dot marks a
  // nap". This is the regression test that would have caught it: it fails the
  // moment any recorded bed time, wake time or nap sits outside the domain
  // the chart actually draws, rather than relying on a screenshot to notice.
  const beds = july.schedule.map((n) => n.bed).filter((v): v is number => v !== null)
  const wakes = july.schedule.map((n) => n.wake).filter((v): v is number => v !== null)
  const naps = july.schedule.flatMap((n) => n.naps)

  it('has at least one recorded nap in the fixture, so this coverage is not vacuous', () => {
    expect(naps.length).toBeGreaterThan(0)
  })

  it.each([
    ['bed', beds],
    ['wake', wakes],
    ['nap', naps],
  ] as const)('plots every %s time within [AXIS_MIN, AXIS_MAX]', (_kind, values) => {
    for (const value of values) {
      expect(value, `${value} falls outside [${AXIS_MIN}, ${AXIS_MAX}]`).toBeGreaterThan(AXIS_MIN)
      expect(value, `${value} falls outside [${AXIS_MIN}, ${AXIS_MAX}]`).toBeLessThan(AXIS_MAX)
    }
  })
})
