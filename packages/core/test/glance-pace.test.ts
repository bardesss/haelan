import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson, insertSamples } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { contextFor, readDay } from '../src/query/glance.ts'

const TODAY = '2026-08-20'
const NOW = Date.parse('2026-08-20T14:30:00Z')
let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const [id, kind] of [['watch', 'device'], ['phone', 'app']] as const) {
    test.db.insert(sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind, createdAtMs: 0 }).run()
  }
})
afterEach(() => test.cleanup())

const iso = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`)
function dates(end: string, days: number): string[] {
  const e = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(e - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}
function day(date: string, rows: [source: string, hhmm: string, value: number][], total: number) {
  insertSamples(test.db, rows.map(([sourceId, hhmm, value]) => ({ personId: 'p1', sourceId, metric: 'steps', utcMs: iso(date, hhmm), value })))
  test.db.insert(daily).values({ personId: 'p1', localDate: date, metric: 'steps', agg: 'sum', source: 'merged', value: total, coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: 1 }).run()
}
const pace = () => readDay(contextFor(new PersonQuery(test.db, 'p1'), { today: TODAY, nowMs: NOW, nameOf: (id) => id })).stepsPace

describe('stepsPace', () => {
  it('is null before today has a step reading', () => {
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '09:00', 1000]], 1000)
    expect(pace()).toBeNull()
  })

  it('counts each past day up to the minute of today\'s last reading, and no further', () => {
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '09:00', 1000], ['watch', '13:52', 500], ['watch', '13:53', 7000]], 8500)
    day(TODAY, [['watch', '13:52', 1500]], 1500)
    const p = pace()!
    expect(p.atMs).toBe(iso(TODAY, '13:52'))
    expect(p.center).toBe(1500) // 09:00 and 13:52 count; 13:53 does not
    expect(p.thin).toBe(false)
  })

  it('counts a phone and a watch in the same hour once, by priority', () => {
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '09:10', 1000], ['phone', '09:20', 900]], 1000)
    day(TODAY, [['watch', '12:00', 10]], 10)
    expect(pace()!.center).toBe(1000)
  })

  it('leaves out a baseline day with no daily row (an excluded or silent day), rather than counting it as zero', () => {
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '09:00', 1000]], 1000)
    insertSamples(test.db, [{ personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: iso('2026-08-18', '08:00'), value: 99_999 }])
    test.db.delete(daily).where(and(eq(daily.personId, 'p1'), eq(daily.localDate, '2026-08-18'))).run()
    day(TODAY, [['watch', '12:00', 10]], 10)
    expect(pace()!.center).toBe(1000)
  })

  it('is thin under the baseline floor', () => {
    for (const date of dates('2026-08-19', 5)) day(date, [['watch', '09:00', 1000]], 1000)
    day(TODAY, [['watch', '12:00', 10]], 10)
    expect(pace()!.thin).toBe(true)
    expect(pace()!.standing).toBeNull()
  })

  it('says ahead, on or behind against the band', () => {
    for (const [i, date] of dates('2026-08-19', 60).entries()) day(date, [['watch', '09:00', 900 + (i % 3) * 100]], 900 + (i % 3) * 100)
    day(TODAY, [['watch', '12:00', 5000]], 5000)
    expect(pace()!.standing).toBe('ahead')
  })

  it('says on when today\'s pace sits within the band', () => {
    for (const [i, date] of dates('2026-08-19', 60).entries()) day(date, [['watch', '09:00', 900 + (i % 3) * 100]], 900 + (i % 3) * 100)
    day(TODAY, [['watch', '12:00', 1000]], 1000)
    expect(pace()!.standing).toBe('on')
  })

  it('says behind when today\'s pace sits below the band', () => {
    for (const [i, date] of dates('2026-08-19', 60).entries()) day(date, [['watch', '09:00', 900 + (i % 3) * 100]], 900 + (i % 3) * 100)
    day(TODAY, [['watch', '12:00', 50]], 50)
    expect(pace()!.standing).toBe('behind')
  })

  it('reads each sample under its own offset, and answers a pace even when today has no daily row yet', () => {
    // 11:30Z at +02:00 is 13:30 local; 12:30Z at +00:00 is 12:30 local. Today's last reading is 13:00 local.
    for (const date of dates('2026-08-19', 60)) {
      insertSamples(test.db, [
        { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: iso(date, '11:30'), tzOffsetMinutes: 120, value: 400 },
        { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: iso(date, '12:30'), tzOffsetMinutes: 0, value: 600 },
      ])
      test.db.insert(daily).values({ personId: 'p1', localDate: date, metric: 'steps', agg: 'sum', source: 'merged', value: 1000, coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: 1 }).run()
    }
    // No daily row for today at all: readStepsPace no longer gates on the steps figure's own
    // value, only on stepsUpToMinute finding a sample and the baseline existing, so a pace shows
    // up before the derivation queue has ever written today's daily row.
    insertSamples(test.db, [{ personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: iso(TODAY, '11:00'), tzOffsetMinutes: 120, value: 10 }])
    expect(pace()!.center).toBe(600)
  })

  it('compares against today\'s own samples, not a stale daily row', () => {
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '09:00', 1000]], 1000)
    // Today's samples say 5000 by noon, but the daily row is a stale 10 - as it would be while the
    // derivation queue has not yet drained today's writes. The standing follows the samples.
    insertSamples(test.db, [{ personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: iso(TODAY, '12:00'), value: 5000 }])
    test.db.insert(daily).values({ personId: 'p1', localDate: TODAY, metric: 'steps', agg: 'sum', source: 'merged', value: 10, coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: 1 }).run()
    const p = pace()!
    expect(p.standing).toBe('ahead')
  })

  it('never counts today\'s own date among the baseline sums, however different today is from the rest', () => {
    for (const date of dates('2026-08-19', 45)) day(date, [['watch', '09:00', 1000]], 1000)
    day(TODAY, [['watch', '12:00', 999_999]], 999_999)
    const p = pace()!
    expect(p.thin).toBe(false)
    expect(p.center).toBe(1000)
  })

  // Task 19a, item 2: just after midnight the usual count by now is a sliver of the usual whole
  // day, so a handful of steps must not read "ahead" of it.
  it('gives no verdict when the usual count by the cutoff time is a sliver of the usual whole day', () => {
    // Every baseline day's activity happens at 09:00, well after today's cutoff, so the usual
    // count "by now" is zero for all sixty of them - a thin-looking band that is not actually thin
    // (60 days, no missing fraction), which is exactly the case PACE_MIN_DAY_SHARE guards.
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '09:00', 8000]], 8000)
    day(TODAY, [['watch', '00:01', 2]], 2)
    const p = pace()!
    expect(p.thin).toBe(false)
    expect(p.center).toBe(0)
    expect(p.standing).toBeNull()
  })

  it('still gives a verdict once the usual count by the cutoff time is a normal share of the usual day', () => {
    // Each baseline day totals 8000 (5000 by noon, 3000 more by evening); today's cutoff is noon,
    // and 5000 by noon is well over 5% of 8000, so the gate above must not apply here.
    for (const date of dates('2026-08-19', 60)) day(date, [['watch', '12:00', 5000], ['watch', '18:00', 3000]], 8000)
    day(TODAY, [['watch', '12:00', 5200]], 5200)
    const p = pace()!
    expect(p.center).toBe(5000)
    expect(p.standing).toBe('ahead')
  })
})
