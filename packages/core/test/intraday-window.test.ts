import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readIntradayWindow } from '../src/query/intraday.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { ConfigError } from '../src/errors.ts'
import { sources } from '../src/db/schema/index.ts'

const OFFSET = 120
// 09:00 local on 2026-08-22 at +120 is 07:00Z.
const NINE_AM = Date.UTC(2026, 7, 22, 7, 0)
const MINUTE = 60_000

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  // Ninety minutes of heart rate, one reading a minute, rising by one beat a minute from 100.
  for (let i = 0; i < 90; i += 1) {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(test.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: NINE_AM + i * MINUTE, tzOffsetMinutes: OFFSET, agg, value: 100 + i,
      })
    }
  }
})
afterEach(() => test.cleanup())

describe('readIntradayWindow', () => {
  it('answers only the readings inside the window', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM + 10 * MINUTE, endMs: NINE_AM + 19 * MINUTE,
    })
    expect(result.points).toHaveLength(10)
    expect(result.points[0]!.utcMs).toBe(NINE_AM + 10 * MINUTE)
    expect(result.points.at(-1)!.utcMs).toBe(NINE_AM + 19 * MINUTE)
    expect(result.points[0]!.mean).toBe(110)
  })

  it('reports no reduction when the window fits the budget', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM, endMs: NINE_AM + 89 * MINUTE, points: 500,
    })
    expect(result.points).toHaveLength(90)
    expect(result.reduction).toBeNull()
  })

  it('thins against the window rather than the day, and says so', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM, endMs: NINE_AM + 89 * MINUTE, points: 20,
    })
    expect(result.points.length).toBeLessThanOrEqual(20)
    expect(result.reduction).toEqual({ method: 'minmax', from: 90, to: result.points.length })
  })

  it('answers nothing for a window with no readings', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM - 10 * MINUTE, endMs: NINE_AM - MINUTE,
    })
    expect(result).toEqual({ points: [], reduction: null })
  })
})

describe('PersonQuery.intradayWindow', () => {
  it('refuses a window that ends before it starts', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.intradayWindow({ metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM - 1 }))
      .toThrow(/startMs .* is after endMs/)
  })

  it('refuses a start that failed to parse to a number', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.intradayWindow({ metric: 'heart_rate', startMs: Number.NaN, endMs: NINE_AM }))
      .toThrow(ConfigError)
  })

  it('answers a session shaped window', () => {
    const q = new PersonQuery(test.db, 'p1')
    const result = q.intradayWindow({
      metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM + 44 * MINUTE,
    })
    expect(result.points).toHaveLength(45)
  })
})
