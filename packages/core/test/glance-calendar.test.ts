import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { judgeCalendarDay } from '../src/query/glanceCalendar.ts'
import type { RawCalendarDay } from '../src/query/glanceCalendar.ts'
import type { GlanceBaseline } from '../src/query/glance.ts'

const TODAY = '2026-09-20'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

/** Upsert, so a fixture can seed a continuous run and then override a handful of days without tripping the `daily_natural` unique constraint. */
function putDaily(o: { metric: string, agg?: string, localDate: string, value: number }) {
  const row = {
    personId: 'p1', localDate: o.localDate, metric: o.metric, agg: o.agg ?? 'sum', source: 'merged',
    value: o.value, coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: 123,
  }
  test.db.insert(daily).values(row).onConflictDoUpdate({
    target: [daily.personId, daily.localDate, daily.metric, daily.agg, daily.source],
    set: { value: row.value, coverage: row.coverage, updatedAtMs: row.updatedAtMs },
  }).run()
}

/** Removes every glance-day row for one local date, turning an ordinary seeded day into a real gap. */
function deleteDay(localDate: string) {
  test.db.delete(daily).where(and(eq(daily.personId, 'p1'), eq(daily.localDate, localDate))).run()
}

/** `days` consecutive local dates ending on `end`, oldest first. */
function datesEnding(end: string, days: number): string[] {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(endMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

/**
 * A steady run of ordinary days from 120 days before TODAY through TODAY, at steps 8000 and sleep
 * 420 minutes: wide enough that every date in September 2026 has a full, non-thin 60-day baseline
 * behind it for both metrics (even TODAY's own window, the latest and shortest-reaching one,
 * starts entirely inside this run). Individual days are then overridden or deleted by the tests
 * that need something different from "an ordinary day".
 */
function seedBaselineHistory() {
  for (const date of datesEnding(TODAY, 120)) {
    putDaily({ metric: 'steps', localDate: date, value: 8_000 })
    putDaily({ metric: 'sleep_asleep_minutes', localDate: date, value: 420 })
  }
}

describe('judgeCalendarDay', () => {
  const band: GlanceBaseline = { center: 420, low: 400, high: 440, thin: false }
  const thinBand: GlanceBaseline = { center: 420, low: 400, high: 440, thin: true }

  function raw(o: Partial<RawCalendarDay>): RawCalendarDay {
    return {
      localDate: '2026-09-07', sleepValue: 420, sleepBand: band, stepsValue: 8_000, stepsBand: band, stepsPartial: false, ...o,
    }
  }

  it('maps a sleep value within its band to within', () => {
    expect(judgeCalendarDay(raw({ sleepValue: 420 })).sleep).toBe('within')
  })

  it('maps a sleep value above its band to outside', () => {
    expect(judgeCalendarDay(raw({ sleepValue: 900 })).sleep).toBe('outside')
  })

  it('maps a sleep value below its band to outside', () => {
    expect(judgeCalendarDay(raw({ sleepValue: 100 })).sleep).toBe('outside')
  })

  it('maps a missing sleep value to null', () => {
    expect(judgeCalendarDay(raw({ sleepValue: null })).sleep).toBeNull()
  })

  it('maps a thin sleep band to null', () => {
    expect(judgeCalendarDay(raw({ sleepBand: thinBand })).sleep).toBeNull()
  })

  it('maps a steps value within its band to reached', () => {
    expect(judgeCalendarDay(raw({ stepsValue: 8_000 })).steps).toBe('reached')
  })

  it('maps a steps value above its band to reached', () => {
    expect(judgeCalendarDay(raw({ stepsValue: 20_000 })).steps).toBe('reached')
  })

  it('maps a steps value below its band to below', () => {
    expect(judgeCalendarDay(raw({ stepsValue: 100 })).steps).toBe('below')
  })

  it('maps a missing steps value to null', () => {
    expect(judgeCalendarDay(raw({ stepsValue: null })).steps).toBeNull()
  })

  it('maps a thin steps band to null', () => {
    expect(judgeCalendarDay(raw({ stepsBand: thinBand })).steps).toBeNull()
  })

  it('maps a partial steps day to null even when the value would otherwise reach its band', () => {
    expect(judgeCalendarDay(raw({ stepsValue: 20_000, stepsPartial: true })).steps).toBeNull()
  })

  it('never treats sleep as partial: stepsPartial alone does not touch the sleep verdict', () => {
    expect(judgeCalendarDay(raw({ sleepValue: 420, stepsPartial: true })).sleep).toBe('within')
  })
})

describe('PersonQuery.glanceCalendar', () => {
  beforeEach(() => seedBaselineHistory())

  it('lists only the days with data, excludes a real gap, and judges an above and a below day', () => {
    deleteDay('2026-09-04') // a real gap: no row at all for either metric
    putDaily({ metric: 'sleep_asleep_minutes', localDate: '2026-09-07', value: 900 }) // above its band -> outside
    putDaily({ metric: 'steps', localDate: '2026-09-10', value: 100 }) // below its band -> below

    const calendar = new PersonQuery(test.db, 'p1').glanceCalendar({ month: '2026-09', today: TODAY })

    expect(calendar.days.some((d) => d.localDate === '2026-09-04')).toBe(false)
    const day03 = calendar.days.find((d) => d.localDate === '2026-09-03')
    expect(day03).toEqual({ localDate: '2026-09-03', sleep: 'within', steps: 'reached' })
    const day07 = calendar.days.find((d) => d.localDate === '2026-09-07')
    expect(day07).toEqual({ localDate: '2026-09-07', sleep: 'outside', steps: 'reached' })
    const day10 = calendar.days.find((d) => d.localDate === '2026-09-10')
    expect(day10).toEqual({ localDate: '2026-09-10', sleep: 'within', steps: 'below' })
  })

  it('marks today\'s steps null because the day is still running, while an earlier day gets a real verdict', () => {
    const calendar = new PersonQuery(test.db, 'p1').glanceCalendar({ month: '2026-09', today: TODAY })
    const todayEntry = calendar.days.find((d) => d.localDate === TODAY)
    const earlier = calendar.days.find((d) => d.localDate === '2026-09-19')
    expect(todayEntry).toEqual({ localDate: TODAY, sleep: 'within', steps: null })
    expect(earlier).toEqual({ localDate: '2026-09-19', sleep: 'within', steps: 'reached' })
  })

  it('gives a night-only day (no steps row at all) a steps verdict of null', () => {
    test.db.delete(daily).where(and(eq(daily.personId, 'p1'), eq(daily.localDate, '2026-09-15'), eq(daily.metric, 'steps'))).run()
    const calendar = new PersonQuery(test.db, 'p1').glanceCalendar({ month: '2026-09', today: TODAY })
    const day = calendar.days.find((d) => d.localDate === '2026-09-15')
    expect(day).toEqual({ localDate: '2026-09-15', sleep: 'within', steps: null })
  })

  it('names firstDay as the earliest day with data anywhere in the archive, not the queried month', () => {
    const calendar = new PersonQuery(test.db, 'p1').glanceCalendar({ month: '2026-09', today: TODAY })
    expect(calendar.firstDay).toBe(datesEnding(TODAY, 120)[0])
  })

  it('answers an empty days list for a month with no data, while firstDay still names the archive\'s own start', () => {
    const calendar = new PersonQuery(test.db, 'p1').glanceCalendar({ month: '2026-01', today: TODAY })
    expect(calendar.days).toEqual([])
    expect(calendar.firstDay).toBe(datesEnding(TODAY, 120)[0])
  })

  it('answers an empty days list and a null firstDay for a person with no data at all', () => {
    const empty = createTestDatabase()
    seedPerson(empty.db, 'p2')
    const calendar = new PersonQuery(empty.db, 'p2').glanceCalendar({ month: '2026-09', today: TODAY })
    expect(calendar.days).toEqual([])
    expect(calendar.firstDay).toBeNull()
    empty.cleanup()
  })
})
