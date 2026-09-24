import { describe, it, expect, afterEach, vi } from 'vitest'
import { installDemoClock } from '../src/demo/demoClock.js'
import { DEMO_CLOCK_MS } from '../src/demo/instant.js'

const NativeDate = Date

afterEach(() => {
  globalThis.Date = NativeDate
  vi.restoreAllMocks()
})

/**
 * The demo's clock has to satisfy two things at once, and the first version satisfied only one.
 *
 * It must READ as the demo's own day, because every url a page asks for is computed from today and
 * the manifest is keyed by those urls. And it must ADVANCE, because zrender - which draws every
 * chart in this app - takes its animation clock from `new Date().getTime()`
 * (zrender/lib/animation/Animation.js). A clock that returns a constant makes every frame's
 * elapsed time zero, so no animation ever progresses and every animated series stays at its
 * initial state: bars drawn at height zero, while axes, labels and tooltips - none of them
 * animated - render normally. That is what shipped: charts with a correct y-axis, working
 * tooltips reading real values, and no bars.
 */
describe('the demo clock', () => {
  it('reads as the demo day, so every recorded url still resolves', () => {
    installDemoClock(DEMO_CLOCK_MS)
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-06')
    expect(new Date(Date.now()).toISOString().slice(0, 10)).toBe('2026-09-06')
  })

  it('advances, because zrender drives every chart animation from new Date()', async () => {
    installDemoClock(DEMO_CLOCK_MS)
    const first = new Date().getTime()
    await new Promise((resolve) => setTimeout(resolve, 40))
    const second = new Date().getTime()
    // The exact quantity does not matter; a zero delta is what stalls every animation.
    expect(second).toBeGreaterThan(first)
    expect(Date.now()).toBeGreaterThan(first)
  })

  it('still reads as the demo day after time has passed', async () => {
    installDemoClock(DEMO_CLOCK_MS)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // The anchor has to leave room for a visitor to sit on the page: pinning to the last
    // millisecond of the day would roll over to the next date on the first tick, and the next
    // date is one the seed wrote nothing for.
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-06')
  })

  it('leaves a date built from arguments alone', () => {
    installDemoClock(DEMO_CLOCK_MS)
    expect(new Date('2020-01-01T00:00:00Z').toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(new Date(0).getTime()).toBe(0)
    expect(new Date(2020, 0, 1).getFullYear()).toBe(2020)
  })

  it("keeps Date's static surface working", () => {
    installDemoClock(DEMO_CLOCK_MS)
    expect(Date.parse('2020-01-01T00:00:00Z')).toBe(1577836800000)
    expect(new Date() instanceof Date).toBe(true)
  })

  it('keeps advancing past its ceiling without leaving the day, by starting over', () => {
    // DEMO_CLOCK_MS sits half an hour before midnight (instant.ts says why), so a tab left open
    // reaches the ceiling within the half hour. A clamp there would freeze the clock and stall
    // every chart that mounts afterwards, the defect this module exists to prevent; the clock
    // loops back to its start instead, so it neither stops nor crosses into the next day.
    let performanceNow = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => performanceNow)
    const start = DEMO_CLOCK_MS
    const ceiling = start + 999
    installDemoClock(start, ceiling)
    expect(Date.now()).toBe(start)
    performanceNow += 999
    expect(Date.now()).toBe(ceiling)
    performanceNow += 1
    expect(Date.now()).toBe(start)
    performanceNow += 10_500
    const later = Date.now()
    expect(later).toBeGreaterThanOrEqual(start)
    expect(later).toBeLessThanOrEqual(ceiling - 16)
    performanceNow += 16
    expect(new Date().getTime()).toBe(later + 16)
  })
})
