import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fillSplitHeartRate } from '../src/api/splitHeartRate.ts'
import type { WorkoutSplit } from '../src/api/workoutSummary.ts'

const MIN = 60_000
const START = Date.UTC(2026, 8, 12, 9, 0)

const split = (fromMinute: number, toMinute: number, bpm: number | null = null): WorkoutSplit => ({
  startMs: START + fromMinute * MIN,
  endMs: START + toMinute * MIN,
  splitType: 'DISTANCE',
  activeDurationSeconds: (toMinute - fromMinute) * 60,
  distanceMeters: 1000,
  paceSecondsPerKm: 300,
  averageHeartRateBpm: bpm,
})

const minutes = (bpms: number[]) => bpms.map((bpm, i) => ({ utcMs: START + i * MIN, bpm }))

describe('filling a split heart rate', () => {
  it('fills a null from the mean of the trace points inside the split', () => {
    const [filled] = fillSplitHeartRate([split(0, 4)], minutes([170, 174, 178, 182]))
    expect(filled!.averageHeartRateBpm).toBe(176)
    expect(filled!.averageHeartRateBpmSource).toBe('trace')
  })

  // The watch's own number always wins. This function exists because the watch sent nothing, not
  // to second-guess it when it did.
  it('never overwrites a value the provider sent', () => {
    const [filled] = fillSplitHeartRate([split(0, 4, 150)], minutes([170, 174, 178, 182]))
    expect(filled!.averageHeartRateBpm).toBe(150)
    expect(filled!.averageHeartRateBpmSource).toBe('provider')
  })

  // Never the session average. That is a number about the run, not about this kilometre, and
  // printing it in this cell would be inventing one.
  it('leaves a split whose window holds no points null', () => {
    const [filled] = fillSplitHeartRate([split(10, 14)], minutes([170, 174, 178, 182]))
    expect(filled!.averageHeartRateBpm).toBeNull()
    expect(filled!.averageHeartRateBpmSource).toBeNull()
  })

  it('takes only the points inside this split, not its neighbours', () => {
    const [first, second] = fillSplitHeartRate(
      [split(0, 2), split(2, 4)],
      minutes([100, 100, 200, 200]),
    )
    expect(first!.averageHeartRateBpm).toBe(100)
    expect(second!.averageHeartRateBpm).toBe(200)
  })

  // Half-open, so a point on a boundary belongs to exactly one split rather than to both. The
  // previous test cannot show that: all four of its minutes already sit strictly inside one split
  // or the other, so any of [start, end), [start, end] or (start, end) would answer it the same
  // way. Here the boundary minute (minute 2, bpm 160) is given a value distinct from both of its
  // neighbours (140 before it, 200 after it) so the two splits' means expose which rule is really
  // running:
  //   split(0, 2) covers minutes 0-1: (120 + 140) / 2 = 130.
  //   split(2, 4) covers minutes 2-3: (160 + 200) / 2 = 180.
  // If the window were closed on the right ([start, end]), split(0, 2) would also pull in minute 2
  // (160) and average (120 + 140 + 160) / 3 = 140, not 130. If it were open on the left
  // ((start, end)), split(2, 4) would drop minute 2 and average 200 alone, not 180. Both wrong
  // answers are different from each other and from the 100 / 200 the neighbour test above asserts,
  // so only the half-open rule this function implements produces 130 and 180.
  it('counts a point on the boundary as the later split\'s', () => {
    const [first, second] = fillSplitHeartRate(
      [split(0, 2), split(2, 4)],
      minutes([120, 140, 160, 200]),
    )
    expect(first!.averageHeartRateBpm).toBe(130)
    expect(second!.averageHeartRateBpm).toBe(180)
  })

  it('leaves a split with no window at all alone', () => {
    const noWindow = { ...split(0, 4), startMs: null, endMs: null }
    const [filled] = fillSplitHeartRate([noWindow], minutes([170, 174]))
    expect(filled!.averageHeartRateBpm).toBeNull()
    expect(filled!.averageHeartRateBpmSource).toBeNull()
  })

  it('keeps a provider zero as a provider zero', () => {
    const [filled] = fillSplitHeartRate([split(0, 4, 0)], minutes([170, 174, 178, 182]))
    expect(filled!.averageHeartRateBpm).toBe(0)
    expect(filled!.averageHeartRateBpmSource).toBe('provider')
  })

  it('answers an empty list for no splits', () => {
    expect(fillSplitHeartRate([], minutes([170]))).toEqual([])
  })
})

// The ninth browser-safe entry point. splitHeartRate.ts is not import-free the way cardioLoad.ts
// and workoutSummary.ts are; it reads WorkoutSplit off workoutSummary.ts and MinuteBpm off
// cardioLoad.ts, both as erased type imports, so this guard allow-lists exactly those two the way
// workout-comparison-subpath.test.ts allow-lists the one import workoutComparison.ts makes.
const SUBPATH = './split-heart-rate'
const TARGET = './src/api/splitHeartRate.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// Matches an `import` statement of any shape, and also an `export ... from '...'` re-export, which
// pulls a module in exactly as surely as an import does but carries no `import` keyword.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/split-heart-rate subpath', () => {
  it('is published, and points at the split heart rate module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports only WorkoutSplit and MinuteBpm, the two sibling api/ modules it needs', () => {
    const importLines = [...read('../src/api/splitHeartRate.ts').matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([
      "import type { WorkoutSplit } from './workoutSummary.ts'",
      "import type { MinuteBpm } from './cardioLoad.ts'",
    ])
  })

  // Both hops it takes are themselves dead ends for a bundler. cardio-load.test.ts and
  // workout-comparison-subpath.test.ts each already pin this for their own reasons; re-checked
  // here so this subpath's own guarantee does not lean on a test living in another file.
  it('reaches workoutSummary.ts and cardioLoad.ts through no further import at all', () => {
    const summaryImports = [...read('../src/api/workoutSummary.ts').matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(summaryImports).toEqual([])
    const cardioLoadImports = [...read('../src/api/cardioLoad.ts').matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(cardioLoadImports).toEqual([])
  })
})
