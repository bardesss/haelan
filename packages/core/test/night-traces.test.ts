import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { sources } from '../src/db/schema/index.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { nightTraceStat, nightTrace } from '../src/query/nightTraces.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

const H = 3_600_000
const NIGHT0 = Date.UTC(2026, 8, 5, 22)
function night(i: number) {
  const startMs = NIGHT0 + i * 24 * H
  return { localDate: `n${i}`, sourceId: 'watch', sessionIds: [], startMs, endMs: startMs + 7 * H,
    startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], segments: [], excludedSessions: [] }
}
function hr(atMs: number, bpm: number) {
  insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: atMs, value: bpm })
}

describe('nightTraceStat', () => {
  it('finds the lowest and highest reading inside the night and when they fell', () => {
    const n = night(0)
    hr(n.startMs + H, 60); hr(n.startMs + 3 * H, 52); hr(n.startMs + 6 * H, 70)
    hr(n.startMs - H, 40)   // before bed: not part of the night
    const stat = nightTraceStat(new PersonQuery(test.db, 'p1'), 'heart_rate', n)
    expect(stat.lowest).toEqual({ value: 52, atMs: n.startMs + 3 * H })
    expect(stat.highest).toEqual({ value: 70, atMs: n.startMs + 6 * H })
    expect(stat.mean).toBeCloseTo((60 + 52 + 70) / 3)
  })
  it('is empty for a night with no readings', () => {
    expect(nightTraceStat(new PersonQuery(test.db, 'p1'), 'heart_rate', night(0))).toEqual({ lowest: null, highest: null, mean: null })
  })
})

describe('nightTraceStat mean (#191)', () => {
  it('computes the true mean from every reading, not a thinned sample', () => {
    // 600 one-minute readings, more than TRACE_POINTS ever was (240), so a thinned read would
    // drop most of them. Mostly 60 bpm with a spike to 200 every 50th minute: thinBand's minmax
    // bucketing keeps each bucket's extremes, so a thinned mean is pulled toward the spikes and
    // moves with the point budget - exactly the #191 shape CONTRIBUTING.md names.
    const startMs = NIGHT0
    const values = Array.from({ length: 600 }, (_, i) => (i % 50 === 0 ? 200 : 60))
    values.forEach((v, i) => hr(startMs + i * 60_000, v))
    const exactMean = values.reduce((sum, v) => sum + v, 0) / values.length
    const stat = nightTraceStat(new PersonQuery(test.db, 'p1'), 'heart_rate', { startMs, endMs: startMs + 600 * 60_000 })
    expect(stat.mean).toBeCloseTo(exactMean, 6)
  })
})

describe('nightTrace', () => {
  it('judges the night against the nightly lowest of the nights before it', () => {
    const history = Array.from({ length: 14 }, (_, i) => night(i))
    history.forEach((n, i) => { hr(n.startMs + H, 50 + (i % 3)); hr(n.startMs + 2 * H, 65) })
    const subject = night(14)
    hr(subject.startMs + H, 58)
    const trace = nightTrace(new PersonQuery(test.db, 'p1'), 'heart_rate', subject, history)
    expect(trace.stat.lowest?.value).toBe(58)
    expect(trace.usualLowest?.thin).toBe(false)
    expect(trace.usualLowest!.high).toBeLessThan(58)
  })
})
