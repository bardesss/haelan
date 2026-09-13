import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSessionHeartRateMinutes } from '../src/query/sessionHeartRate.ts'
import { sources } from '../src/db/schema/index.ts'

const OFFSET = 120
// 09:00 local on 2026-08-22 at +120 is 07:00Z.
const START = Date.UTC(2026, 7, 22, 7, 0)
const FAR_LATER = Date.UTC(2026, 9, 1, 0, 0)
const MINUTE = 60_000
// Every window below that wants exactly 90 stored minutes ends here: readIntradayWindow's bounds
// are inclusive, so [START, START + 89 * MINUTE] covers indices 0..89, ninety readings exactly,
// the same off-by-one intraday-window.test.ts already settled on.
const NINETY_END = START + 89 * MINUTE

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  // Three sources: 'watch' is the session's own recording device, 'phone' is another device that
  // also logged heart rate, and 'ring' is registered but never logs a reading in this span - it
  // exists only to be the session's device for the fallback test below.
  for (const id of ['watch', 'phone', 'ring']) {
    test.db.insert(sources).values({
      id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  }
  // 700 minutes of heart rate on 'watch', one reading a minute: comfortably past readWindow's own
  // DEFAULT_POINTS = 500 (query/intraday.ts), which is what actually applies here since this
  // reader queries one source at a time (perSource = max(2, floor(500 / 1)) = 500 with no
  // `points` given). 400 was tried first and was wrong: it is under 500, so thinBand's
  // "nothing to do" branch (points.length <= target) fires with or without NO_THINNING, and the
  // test could not have told a real unthinned read apart from an accidentally-default one. Heart
  // rate is stored downsampled to the minute, so each minute needs all three of min/mean/max
  // written (the pattern intraday-window.test.ts uses).
  for (let i = 0; i < 700; i += 1) {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(test.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: START + i * MINUTE, tzOffsetMinutes: OFFSET, agg, value: 100 + (i % 60),
      })
    }
  }
  // Ninety minutes on 'phone', overlapping watch's own span. This is what makes the pinned test
  // below meaningful - if the reader ever blended sources instead of pinning, its count would be
  // 90 either way, but its values would shift - and it is also what the fallback test falls back
  // to.
  for (let i = 0; i < 90; i += 1) {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(test.db, {
        personId: 'p1', sourceId: 'phone', metric: 'heart_rate',
        utcMs: START + i * MINUTE, tzOffsetMinutes: OFFSET, agg, value: 130 + i,
      })
    }
  }
})
afterEach(() => test.cleanup())

describe('the session heart rate reader', () => {
  it('answers one point per stored minute, pinned to the recording device', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: NINETY_END, sessionSourceId: 'watch',
    })
    expect(result.minutes).toHaveLength(90)
    expect(result.traceSource).toBe('pinnedSource')
    expect(result.sourceId).toBe('watch')
  })

  // The defect this module exists to prevent. get_workout's trace is thinned to a caller-supplied
  // point budget with minmax bucketing, which keeps each bucket's EXTREMES - so a mean taken over
  // those points is biased, and biased by an argument about display. The same kilometre would
  // report a different BPM at points: 50 than at points: 300. A derived number may not move when
  // a chart's budget moves.
  //
  // This is the only test in the suite that would notice if someone "simplified" this reader into
  // reusing the thinned trace, or dropped `points: NO_THINNING` from the `read` helper - the most
  // natural way anyone would ever break this. The number to beat is readWindow's own
  // DEFAULT_POINTS = 500 (query/intraday.ts): this reader queries one source at a time, so an
  // accidental default gives thinBand a target of max(2, floor(500 / 1)) = 500, and 700 seeded
  // minutes coming back as 700 points is proof nothing was thinned against that budget. (A
  // companion assertion calling the reader twice with the same arguments and comparing the
  // results was dropped - that only proves the function is deterministic, not that it is
  // unthinned.)
  it('returns every stored minute, past the point budget any chart would ask for', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: START + 700 * MINUTE, sessionSourceId: 'watch',
    })
    expect(result.minutes).toHaveLength(700)
    expect(result.minutes.length).toBeGreaterThan(500)
  })

  it('falls back to every other source when the recording device logged nothing', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: NINETY_END, sessionSourceId: 'ring',
    })
    expect(result.traceSource).toBe('otherSources')
    expect(result.minutes.length).toBeGreaterThan(0)
  })

  // An explicit choice gets a specific answer, empty or not. Silently answering a different
  // question is the failure the fallback rule exists to prevent.
  it('never falls back when a source was named', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: NINETY_END,
      sessionSourceId: 'watch', chosenSourceId: 'ring',
    })
    expect(result.minutes).toEqual([])
    expect(result.traceSource).toBe('pinnedSource')
  })

  // MINOR 9. Every other fixture in this file writes min = mean = max for a minute (the same
  // pattern the beforeEach block above uses), which cannot distinguish "reads mean" from "reads
  // min" or "reads max" - a reader that quietly switched to preferring max would still pass every
  // other test here. 'ring' carries no heart rate anywhere else in this file, so seeding one
  // minute of genuinely distinct values on it cannot collide with the shared fixture above.
  it('reads the mean aggregate for a minute whose min, mean and max genuinely differ', () => {
    const distinctAt = START + 500 * MINUTE
    insertSample(test.db, {
      personId: 'p1', sourceId: 'ring', metric: 'heart_rate',
      utcMs: distinctAt, tzOffsetMinutes: OFFSET, agg: 'min', value: 90,
    })
    insertSample(test.db, {
      personId: 'p1', sourceId: 'ring', metric: 'heart_rate',
      utcMs: distinctAt, tzOffsetMinutes: OFFSET, agg: 'mean', value: 110,
    })
    insertSample(test.db, {
      personId: 'p1', sourceId: 'ring', metric: 'heart_rate',
      utcMs: distinctAt, tzOffsetMinutes: OFFSET, agg: 'max', value: 130,
    })

    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: distinctAt, endMs: distinctAt, sessionSourceId: 'ring',
    })

    expect(result.minutes).toEqual([{ utcMs: distinctAt, bpm: 110 }])
  })

  it('answers no minutes when nobody recorded a heart rate in the span', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: FAR_LATER, endMs: FAR_LATER + MINUTE, sessionSourceId: 'watch',
    })
    expect(result.minutes).toEqual([])
  })

  // Pins the reader's OWN output contract - chronological, oldest first - not which module
  // currently guarantees it. readWindow already sorts its own result by utcMs today
  // (query/intraday.ts, the final `.sort` on `perSourcePoints.flat()`), so this module's own
  // `.sort()` in sessionHeartRate.ts is presently redundant; it stays as a stated defense because
  // later readers (a split's window, a running sum over a session) depend on strict chronological
  // order and this module would rather guarantee that itself than depend on another module's
  // internal ordering staying true. This test would pass identically whichever of the two sorts
  // produced the order - it is not evidence that sessionHeartRate.ts's own `.sort()` does
  // anything today, only that the final output is chronological.
  it('answers minutes in chronological order', () => {
    const { minutes } = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: NINETY_END, sessionSourceId: 'watch',
    })
    const times = minutes.map((m) => m.utcMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
