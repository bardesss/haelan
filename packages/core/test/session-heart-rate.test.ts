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
  // 400 minutes of heart rate on 'watch', one reading a minute: past the 300-point default budget
  // every charting caller uses, so the budget-independence test below can tell a real, unthinned
  // read apart from a thinned one. Heart rate is stored downsampled to the minute, so each minute
  // needs all three of min/mean/max written (the pattern intraday-window.test.ts uses).
  for (let i = 0; i < 400; i += 1) {
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
  // reusing the thinned trace: 400 minutes are seeded in the window, past the 300-point default
  // budget every charting caller uses, so 400 stored minutes coming back as 400 points is the
  // proof that no thinning happened. (A companion assertion calling the reader twice with the
  // same arguments and comparing the results was dropped - that only proves the function is
  // deterministic, not that it is unthinned.)
  it('returns every stored minute, past the point budget any chart would ask for', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: START + 400 * MINUTE, sessionSourceId: 'watch',
    })
    expect(result.minutes).toHaveLength(400)
    expect(result.minutes.length).toBeGreaterThan(300)
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

  it('answers no minutes when nobody recorded a heart rate in the span', () => {
    const result = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: FAR_LATER, endMs: FAR_LATER + MINUTE, sessionSourceId: 'watch',
    })
    expect(result.minutes).toEqual([])
  })

  it('is sorted oldest first', () => {
    const { minutes } = readSessionHeartRateMinutes(test.db, {
      personId: 'p1', startMs: START, endMs: NINETY_END, sessionSourceId: 'watch',
    })
    const times = minutes.map((m) => m.utcMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
