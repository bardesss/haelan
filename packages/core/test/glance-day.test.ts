import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sessions, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'

const TODAY = '2026-08-20'
const NOW = Date.parse('2026-08-20T10:00:00Z')
const DAY = '2026-08-15'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

/** The last millisecond of `date`'s local day - the route's own `localMidnightMs` arithmetic, with no real zone since these tests use plain UTC dates throughout. */
function dayEndMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) + 86_400_000 - 1
}

function insert(o: { metric: string, agg?: string, localDate: string, value: number }) {
  test.db.insert(daily).values({
    personId: 'p1', localDate: o.localDate, metric: o.metric, agg: o.agg ?? 'sum', source: 'merged',
    value: o.value, coverage: 1, sourceMix: JSON.stringify([{ source: 'watch', share: 1 }]),
    derivationVersion: DERIVATION_VERSION, updatedAtMs: 123,
  }).run()
}

/** `days` consecutive dates ending on `end`, oldest first. */
function datesEnding(end: string, days: number): string[] {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(endMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

let sleepSeq = 0
/** A night ending the morning of `localDate`, the same shape glance.test.ts's own `sleep` helper writes. */
function sleepNight(localDate: string) {
  sleepSeq += 1
  const id = `sleep-${sleepSeq}`
  const endMs = Date.parse(`${localDate}T05:10:00Z`)
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
    startMs: endMs - 7 * 3_600_000, startOffsetMinutes: 120, endMs, endOffsetMinutes: 120,
    localDate, attrs: JSON.stringify({}), rawPayloadId: null,
  }).run()
}

/**
 * 70 continuous days of steps, active minutes and a nightly sleep session ending on `TODAY`,
 * wide enough to cover both TODAY's and DAY's 60-day baseline windows (each ends the day before
 * its own `on`), so neither baseline comes back thin.
 */
function seedSixtyDaysOfEverything() {
  for (const date of datesEnding(TODAY, 70)) {
    insert({ metric: 'steps', localDate: date, value: date === DAY ? 20_000 : 8_000 })
    insert({ metric: 'active_minutes_light', localDate: date, value: 30 })
    insert({ metric: 'active_minutes_moderate', localDate: date, value: 10 })
    insert({ metric: 'active_minutes_vigorous', localDate: date, value: 5 })
    insert({ metric: 'sleep_asleep_minutes', localDate: date, value: 420 })
    sleepNight(date)
    // A step sample every day, DAY included: without it stepsUpToMinute has nothing to answer
    // from and readStepsPace is null regardless of `finished`, which would let a stepsPace that
    // ignored `finished` pass unnoticed.
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: Date.parse(`${date}T09:00:00Z`), value: date === DAY ? 20_000 : 8_000 })
  }
}

describe('glance for a finished day', () => {
  beforeEach(() => seedSixtyDaysOfEverything())

  it('builds the day as finished, current to the end of that day', () => {
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, day: DAY, dayEndMs: dayEndMs(DAY) })
    expect(glance.today).toBe(DAY)
    expect(glance.finished).toBe(true)
    expect(glance.day.steps.partial).toBe(false)
    expect(glance.day.steps.standing).not.toBeNull()
    expect(glance.day.stepsPace).toBeNull()
    expect(glance.day.activeMinutes.partial).toBe(false)
    expect(glance.sleep!.localDate).toBe(DAY)
    expect(glance.week.steps).not.toBeNull()
    expect(glance.week.steps!.days).toBe(7)
    // 6 days of 8000 plus DAY itself at 20000, all seven counted (weekOfFinished).
    expect(glance.week.steps!.perDay).toBeCloseTo((6 * 8_000 + 20_000) / 7)
  })

  it('leaves today unchanged: still running, steps and the week card as before', () => {
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW })
    expect(glance.finished).toBe(false)
    expect(glance.day.steps.partial).toBe(true)
    // 70 continuous days behind TODAY, so all six finished strip days have a value.
    expect(glance.week.steps!.days).toBe(6)
  })

  it('draws the finished day\'s own heart-rate trace, not today\'s', () => {
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: Date.parse(`${DAY}T08:00:00Z`), agg: 'mean', value: 60 })
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: Date.parse(`${TODAY}T08:00:00Z`), agg: 'mean', value: 90 })
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, day: DAY, dayEndMs: dayEndMs(DAY) })
    expect(glance.day.heartRate.points.length).toBeGreaterThan(0)
    expect(glance.day.heartRate.points.every((p) => p.utcMs < dayEndMs(DAY) + 1 && p.utcMs >= Date.parse(`${DAY}T00:00:00Z`))).toBe(true)
  })
})

describe('glance recovery on a finished day', () => {
  // The day before DAY (2026-08-14) scores, standing in for the "today" of glance.test.ts's own
  // seedBaselines pattern; DAY itself (2026-08-15) has no reading at all.
  const D_MINUS_1 = '2026-08-14'

  beforeEach(() => {
    for (const date of datesEnding('2026-08-13', 60)) {
      insert({ metric: 'daily_hrv', agg: 'last', localDate: date, value: 40 + (Number(date.slice(8)) % 5) })
      insert({ metric: 'resting_heart_rate', agg: 'last', localDate: date, value: 55 + (Number(date.slice(8)) % 3) })
      insert({ metric: 'sleep_asleep_minutes', localDate: date, value: 420 })
      insert({ metric: 'sleep_bedtime_minutes', agg: 'last', localDate: date, value: -30 })
    }
    insert({ metric: 'daily_hrv', agg: 'last', localDate: D_MINUS_1, value: 44 })
    insert({ metric: 'resting_heart_rate', agg: 'last', localDate: D_MINUS_1, value: 55 })
  })

  it('does not fall back to the day before when the finished day itself has no reading', () => {
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, day: DAY, dayEndMs: dayEndMs(DAY) })
    expect(glance.recovery.index.value).toBeNull()
    expect(glance.recovery.index.asOfDate).toBeNull()
    expect(glance.recovery.restingHeartRate.value).toBeNull()
    expect(glance.recovery.hrv.value).toBeNull()
    expect(glance.recovery.missing).not.toBeNull()
  })

  it('scores the finished day itself when it has a reading', () => {
    insert({ metric: 'daily_hrv', agg: 'last', localDate: DAY, value: 44 })
    insert({ metric: 'resting_heart_rate', agg: 'last', localDate: DAY, value: 55 })
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, day: DAY, dayEndMs: dayEndMs(DAY) })
    expect(glance.recovery.index.value).not.toBeNull()
    expect(glance.recovery.index.asOfDate).toBe(DAY)
    expect(glance.recovery.restingHeartRate).toMatchObject({ value: 55, asOfDate: DAY })
  })
})

describe('glance validation', () => {
  it('refuses dayEndMs given without day', () => {
    expect(() => new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, dayEndMs: dayEndMs(DAY) })).toThrow(/dayEndMs/)
  })
})

describe('glance nav', () => {
  beforeEach(() => {
    for (const date of ['2026-08-13', '2026-08-15', '2026-08-18']) insert({ metric: 'steps', localDate: date, value: 100 })
    // A day strictly after TODAY: without `until` bounding the search at the caller's real today,
    // `next` for TODAY itself would find this instead of stopping at null.
    insert({ metric: 'steps', localDate: '2026-08-21', value: 100 })
  })

  it('points to the nearest days with data before and after', () => {
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, day: '2026-08-15', dayEndMs: dayEndMs('2026-08-15') })
    expect(glance.nav).toEqual({ previous: '2026-08-13', next: '2026-08-18' })
  })

  it('never points past today', () => {
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW })
    expect(glance.nav.next).toBeNull()
  })

  it('has no previous day before the first one with data', () => {
    const glance = new PersonQuery(test.db, 'p1').glance({ today: TODAY, nowMs: NOW, day: '2026-08-13', dayEndMs: dayEndMs('2026-08-13') })
    expect(glance.nav.previous).toBeNull()
  })
})
