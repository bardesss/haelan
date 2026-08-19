import { describe, it, expect } from 'vitest'
import { nightMark } from '../src/charts/schedule.js'
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
  const recorded = july.schedule.flatMap((n) => [n.bed, n.wake].filter((v): v is number => v !== null))

  it('parks the absence dot clear of every real bed and wake time', () => {
    // At 18:00 it sat ten minutes below a wake-time cluster spanning 1810 to
    // 1951, which reads as an early morning rather than as a missing night.
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
