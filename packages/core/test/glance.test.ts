import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { contextFor, dailyFigure, readDay, readLastNight } from '../src/query/glance.ts'

const TODAY = '2026-08-20'
const NOW = Date.parse('2026-08-20T10:00:00Z')

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

const mix = (...ids: string[]) => JSON.stringify(ids.map((source) => ({ source, share: 1 / ids.length })))

function insert(o: { metric: string, agg?: string, localDate: string, value: number, source?: string, sourceMix?: string | null }) {
  test.db.insert(daily).values({
    personId: 'p1', localDate: o.localDate, metric: o.metric, agg: o.agg ?? 'sum', source: o.source ?? 'merged',
    value: o.value, coverage: 1, sourceMix: o.sourceMix === undefined ? mix('watch') : o.sourceMix,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: 123,
  }).run()
}

/** `days` consecutive dates ending on `end`, oldest first. */
function datesEnding(end: string, days: number): string[] {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(endMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

const ctx = () => contextFor(new PersonQuery(test.db, 'p1'), { today: TODAY, nowMs: NOW, nameOf: (id) => `name:${id}` })

describe('dailyFigure', () => {
  it('carries the day\'s value, a seven day strip ending on it, and the day it belongs to', () => {
    for (const [i, date] of datesEnding(TODAY, 7).entries()) insert({ metric: 'steps', localDate: date, value: 1000 + i })
    const figure = dailyFigure(ctx(), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: 999 })
    expect(figure.value).toBe(1006)
    // METRICS['steps'].unit is 'count', not the literal string 'steps' - the unit comes from the
    // catalogue, so this pins that rather than a coincidental match on the metric's own name.
    expect(figure.unit).toBe('count')
    expect(figure.asOfDate).toBe(TODAY)
    expect(figure.asOfMs).toBe(999)
    expect(figure.partial).toBe(true)
    expect(figure.strip.map((d) => d.value)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006])
    expect(figure.strip.at(-1)!.localDate).toBe(TODAY)
  })

  it('leaves a silent day as a null in the strip, and a silent figure date with no value, no as-of and no time', () => {
    insert({ metric: 'steps', localDate: '2026-08-15', value: 500 })
    const figure = dailyFigure(ctx(), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: 999 })
    expect(figure.value).toBeNull()
    expect(figure.asOfDate).toBeNull()
    expect(figure.asOfMs).toBeNull()
    expect(figure.strip.map((d) => d.value)).toEqual([null, 500, null, null, null, null, null])
  })

  it('states the baseline as a centre and a band, and says when it is thin', () => {
    // Sixty days, not the thirty the brief's own draft used: baseline()'s default window is also
    // sixty days, and thirty of sixty covers only half of it, which trips the day-fraction guard
    // (INSIGHT_MIN_DAY_FRACTION, baseline.ts) and comes back thin regardless of day count. Sixty
    // days of full coverage is what a well-covered baseline actually looks like.
    for (const date of datesEnding('2026-08-19', 60)) insert({ metric: 'steps', localDate: date, value: 8000 })
    const figure = dailyFigure(ctx(), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: null })
    expect(figure.baseline).toEqual({ center: 8000, low: 8000, high: 8000, thin: false })
  })

  it('never takes its time from the row\'s write time', () => {
    insert({ metric: 'steps', localDate: TODAY, value: 10 })
    expect(dailyFigure(ctx(), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: null }).asOfMs).toBeNull()
  })
})

describe('staleness', () => {
  it('names a stale source that fed the figure, and not one that is still reporting', () => {
    test.db.insert(sources).values({ id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'Phone', kind: 'device', createdAtMs: 0 }).run()
    // The watch reported daily for 30 days and stopped 20 days ago: stale by its own cadence.
    for (const date of datesEnding('2026-07-31', 30)) insert({ metric: 'steps', localDate: date, value: 1, source: 'watch', sourceMix: null })
    // The phone reported every day up to today: still reporting.
    for (const date of datesEnding(TODAY, 30)) insert({ metric: 'steps', localDate: date, value: 1, source: 'phone', sourceMix: null })
    for (const date of datesEnding(TODAY, 7)) insert({ metric: 'steps', localDate: date, value: 5, sourceMix: mix('watch', 'phone') })
    const figure = dailyFigure(ctx(), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: null })
    expect(figure.staleSources).toEqual([{ sourceId: 'watch', name: 'name:watch', lastReportedDate: '2026-07-31', medianGapDays: 1 }])
  })
})

describe('readDay', () => {
  const at = (hh: number, mm = 0) => Date.parse(`2026-08-20T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`)

  it('states steps so far as partial, current to the last step sample of today', () => {
    insert({ metric: 'steps', localDate: TODAY, value: 3200 })
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: at(8, 10), value: 40 })
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: at(9, 40), value: 12 })
    const { steps } = readDay(ctx())
    expect(steps).toMatchObject({ value: 3200, partial: true, asOfDate: TODAY, asOfMs: at(9, 40) })
  })

  it('sums the three activity levels into active minutes, per day, and baselines the sum', () => {
    // Sixty days, not thirty: baselineOf's default window is sixty days, and thirty of sixty
    // covers only half of it, which trips the day-fraction guard (INSIGHT_MIN_DAY_FRACTION,
    // baseline.ts) and comes back thin regardless of day count, same as dailyFigure's own
    // baseline test above.
    for (const date of datesEnding('2026-08-19', 60)) {
      insert({ metric: 'active_minutes_light', localDate: date, value: 30 })
      insert({ metric: 'active_minutes_moderate', localDate: date, value: 10 })
      insert({ metric: 'active_minutes_vigorous', localDate: date, value: 5 })
    }
    insert({ metric: 'active_minutes_light', localDate: TODAY, value: 12 })
    const { activeMinutes } = readDay(ctx())
    expect(activeMinutes.value).toBe(12)
    expect(activeMinutes.strip.at(-2)!.value).toBe(45)
    expect(activeMinutes.baseline).toMatchObject({ center: 45, thin: false })
  })

  it('draws today\'s heart rate so far, current to its last sample', () => {
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(9, 55), agg: 'mean', value: 64 })
    const { heartRate } = readDay(ctx())
    expect(heartRate.points.length).toBeGreaterThan(0)
    expect(heartRate.asOfMs).toBe(at(9, 55))
  })

  it('answers a person with nothing today with empty figures rather than an error', () => {
    const day = readDay(ctx())
    expect(day.steps.value).toBeNull()
    expect(day.activeMinutes.value).toBeNull()
    expect(day.heartRate).toEqual({ points: [], asOfMs: null, staleSources: [] })
  })
})

describe('readLastNight', () => {
  function sleep(o: { id: string, localDate: string, startIso: string, endIso: string, sourceId?: string }) {
    test.db.insert(sessions).values({
      id: o.id, personId: 'p1', sourceId: o.sourceId ?? 'watch', kind: 'sleep', externalId: o.id,
      startMs: Date.parse(o.startIso), startOffsetMinutes: 120, endMs: Date.parse(o.endIso), endOffsetMinutes: 120,
      localDate: o.localDate, attrs: JSON.stringify({}), rawPayloadId: null,
    }).run()
  }

  it('picks the night that ended most recently, and shows it whole across midnight', () => {
    sleep({ id: 'n19', localDate: '2026-08-19', startIso: '2026-08-18T21:00:00Z', endIso: '2026-08-19T05:00:00Z' })
    sleep({ id: 'n20', localDate: TODAY, startIso: '2026-08-19T21:30:00Z', endIso: '2026-08-20T05:10:00Z' })
    insert({ metric: 'sleep_asleep_minutes', localDate: TODAY, value: 430 })
    const night = readLastNight(ctx())!
    expect(night.localDate).toBe(TODAY)
    expect(night.startMs).toBe(Date.parse('2026-08-19T21:30:00Z'))
    expect(night.endMs).toBe(Date.parse('2026-08-20T05:10:00Z'))
    expect(night.asleep).toMatchObject({ value: 430, partial: false, asOfDate: TODAY, asOfMs: night.endMs })
  })

  it('chooses by when a night ended, not by the date it is filed under', () => {
    // Filed under yesterday but ending this morning - the rule must not care which date key a
    // night carries, which is the whole reason it reads endMs.
    sleep({ id: 'odd', localDate: '2026-08-19', startIso: '2026-08-19T22:00:00Z', endIso: '2026-08-20T06:00:00Z' })
    expect(readLastNight(ctx())!.endMs).toBe(Date.parse('2026-08-20T06:00:00Z'))
  })

  it('has no last night when the latest night ended more than 36 hours ago', () => {
    sleep({ id: 'old', localDate: '2026-08-18', startIso: '2026-08-17T21:00:00Z', endIso: '2026-08-18T05:00:00Z' })
    expect(readLastNight(ctx())).toBeNull()
  })

  it('never counts a night that has not ended yet at `nowMs`', () => {
    sleep({ id: 'future', localDate: TODAY, startIso: '2026-08-20T09:00:00Z', endIso: '2026-08-20T11:00:00Z' })
    expect(readLastNight(ctx())).toBeNull()
  })
})
