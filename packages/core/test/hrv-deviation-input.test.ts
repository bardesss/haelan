import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readHrvDeviation } from '../src/query/hrvDeviationInput.ts'
import { hrvDeviationWindowStart } from '../src/query/hrvDeviation.ts'

let test: TestDatabase
beforeEach(() => { test = createTestDatabase(); seedPerson(test.db, 'p1') })
afterEach(() => test.cleanup())

const insert = (metric: string, agg: string, localDate: string, value: number) => test.db.insert(daily).values({
  personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
  derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
}).run()

const range = { from: '2026-09-01', to: '2026-09-10' }

/** Alternating 40/44 daily readings from the window start to `last`, then a dip from `dipFrom` to `range.to`. */
function seedDip(dipFrom: string, fillFrom?: string): void {
  let i = 0
  for (let date = hrvDeviationWindowStart(range.from); date <= range.to; date = shiftLocalDate(date, 1), i += 1) {
    const value = date >= dipFrom ? 25 : (i % 2 === 0 ? 40 : 44)
    if (fillFrom !== undefined && date >= fillFrom) insert('hrv', 'mean', date, value)
    else insert('daily_hrv', 'last', date, value)
  }
}

describe('readHrvDeviation', () => {
  it('reads from the window start, and not a day before it', () => {
    const start = hrvDeviationWindowStart(range.from)
    insert('daily_hrv', 'last', shiftLocalDate(start, -1), 99)
    insert('daily_hrv', 'last', start, 40)
    const { series } = readHrvDeviation(new PersonQuery(test.db, 'p1'), range)
    expect(series.points.map((p) => p.localDate)).toEqual([start])
  })

  it('covers exactly the range, oldest first', () => {
    seedDip('2026-09-06')
    const { days } = readHrvDeviation(new PersonQuery(test.db, 'p1'), range)
    expect(days.map((d) => d.localDate)).toEqual(
      ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'],
    )
  })

  it('computes the run as of range.to, for a dip that begins after range.from', () => {
    seedDip('2026-09-06')
    const { days, run } = readHrvDeviation(new PersonQuery(test.db, 'p1'), range)
    expect(days[0]).toMatchObject({ measured: true, side: 'within' })
    expect(run).toMatchObject({ side: 'below', filledDays: 0 })
    expect(run!.days).toBeGreaterThanOrEqual(3)
    expect(run!.since > range.from).toBe(true)
  })

  it('counts a day that only has the intraday mean as filled', () => {
    seedDip('2026-09-06', '2026-09-09')
    const { series, run } = readHrvDeviation(new PersonQuery(test.db, 'p1'), range)
    expect(series.points.filter((p) => p.filled).map((p) => p.localDate)).toEqual(['2026-09-09', '2026-09-10'])
    expect(run).not.toBeNull()
    expect(run!.filledDays).toBe(2)
  })
})
