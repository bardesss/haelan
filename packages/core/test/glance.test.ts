import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { contextFor, dailyFigure, readDay, readGlance, readLastNight, readRecovery, standingOf } from '../src/query/glance.ts'

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
  const watchStale = { sourceId: 'watch', name: 'name:watch', lastReportedDate: '2026-07-31', medianGapDays: 1 }

  /**
   * The shape derivation actually writes when a device stops: the watch has device rows for 30
   * days ending 20 days before TODAY, and the merged rows of those days name it in their mix;
   * after it stops, the merged rows name only the phone, which keeps reporting through TODAY. So
   * nothing in the last seven days mentions the watch at all, which is exactly why a figure has
   * to look back further than its strip to notice it went quiet.
   *
   * The watch also measures blood oxygen, which the phone never does (seeded once in beforeEach,
   * since some tests call this for several metrics). A phone that went on reporting every metric
   * the watch did would make the watch "continued elsewhere" (sourceActivity.ts), which is the
   * renamed-device case below rather than a dead watch.
   */
  function seedWatchThenPhone(metric: string, agg: string) {
    for (const date of datesEnding('2026-07-31', 30)) {
      insert({ metric, agg, localDate: date, value: 1, source: 'watch', sourceMix: null })
      insert({ metric, agg, localDate: date, value: 1, source: 'phone', sourceMix: null })
      insert({ metric, agg, localDate: date, value: 1, sourceMix: mix('watch', 'phone') })
    }
    for (const date of datesEnding(TODAY, 20)) {
      insert({ metric, agg, localDate: date, value: 1, source: 'phone', sourceMix: null })
      insert({ metric, agg, localDate: date, value: 1, sourceMix: mix('phone') })
    }
  }

  beforeEach(() => {
    test.db.insert(sources).values({ id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'Phone', kind: 'device', createdAtMs: 0 }).run()
    for (const date of datesEnding('2026-07-31', 30)) {
      insert({ metric: 'spo2', agg: 'mean', localDate: date, value: 1, source: 'watch', sourceMix: null })
    }
  })

  it('names a stale source that fed the figure before it went quiet, and not one that is still reporting', () => {
    seedWatchThenPhone('steps', 'sum')
    const figure = dailyFigure(ctx(), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: null })
    expect(figure.staleSources).toEqual([watchStale])
  })

  it('names it on today\'s heart rate and on the recovery index when those were fed the same way', () => {
    seedWatchThenPhone('heart_rate', 'mean')
    seedWatchThenPhone('resting_heart_rate', 'last')
    seedWatchThenPhone('daily_hrv', 'last')
    expect(readDay(ctx()).heartRate.staleSources).toEqual([watchStale])
    const recovery = readRecovery(ctx())
    expect(recovery.restingHeartRate.staleSources).toEqual([watchStale])
    expect(recovery.index.staleSources).toEqual([watchStale])
  })

  it('names no source on the recovery card when the watch only changed its name', () => {
    // The false positive this guards: the provider named the same watch two ways, so its first
    // weeks sit under a source id that has been silent since, while the watch itself reports
    // every day under the other. The recovery figures' baselines reach back into the old name's
    // rows, so without the continuation check the card warned that a working watch had stopped.
    test.db.insert(sources).values({ id: 'watch-renamed', personId: 'p1', externalId: 'watch-renamed', displayName: 'Watch, long name', kind: 'device', createdAtMs: 0 }).run()
    for (const metric of ['resting_heart_rate', 'daily_hrv']) {
      for (const date of datesEnding('2026-07-31', 30)) {
        insert({ metric, agg: 'last', localDate: date, value: 1, source: 'watch-renamed', sourceMix: null })
        insert({ metric, agg: 'last', localDate: date, value: 1, sourceMix: mix('watch-renamed') })
      }
      for (const date of datesEnding(TODAY, 20)) {
        insert({ metric, agg: 'last', localDate: date, value: 1, source: 'watch', sourceMix: null })
        insert({ metric, agg: 'last', localDate: date, value: 1, sourceMix: mix('watch') })
      }
    }
    const recovery = readRecovery(ctx())
    expect(recovery.restingHeartRate.staleSources).toEqual([])
    expect(recovery.index.staleSources).toEqual([])
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
    expect(day.workouts).toEqual([])
  })

  // The companion app and the Google Health API both deliver the morning's run, and the glance
  // answers it once, the same merged workout the Activity list shows, with yesterday's left out.
  it('lists today\'s workouts, one per event however many sources recorded it', () => {
    test.db.insert(sources).values({ id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'Phone', kind: 'app', createdAtMs: 0 }).run()
    const workout = (id: string, sourceId: string, startMs: number, localDate: string, attrs: unknown) =>
      test.db.insert(sessions).values({
        id, personId: 'p1', sourceId, kind: 'exercise', externalId: id,
        startMs, startOffsetMinutes: 120, endMs: startMs + 40 * 60_000, endOffsetMinutes: 120,
        localDate, attrs: JSON.stringify(attrs), rawPayloadId: null,
      }).run()
    workout('yesterday-ride', 'watch', at(6) - 86_400_000, '2026-08-19', { exerciseType: 'BIKING' })
    workout('watch-run', 'watch', at(6), TODAY, { exerciseType: 'RUNNING', displayName: 'Morning Run' })
    workout('phone-run', 'phone', at(6, 1), TODAY, { exerciseType: 'RUNNING', displayName: null })

    const { workouts } = readDay(ctx())
    // The watch is a device and the phone an app, so with no list configured the watch ranks first.
    expect(workouts.map((w) => [w.id, w.sources, w.alternateIds])).toEqual([['watch-run', ['watch', 'phone'], ['phone-run']]])
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

describe('readRecovery', () => {
  const seedBaselines = (o: { respiratory?: number, today?: boolean } = {}) => {
    for (const date of datesEnding('2026-08-19', 60)) {
      insert({ metric: 'daily_hrv', agg: 'last', localDate: date, value: 40 + (Number(date.slice(8)) % 5) })
      insert({ metric: 'resting_heart_rate', agg: 'last', localDate: date, value: 55 + (Number(date.slice(8)) % 3) })
      insert({ metric: 'respiratory_rate', agg: 'last', localDate: date, value: 14 + (Number(date.slice(8)) % 2) * 0.4 })
      insert({ metric: 'sleep_asleep_minutes', localDate: date, value: 420 })
      insert({ metric: 'sleep_bedtime_minutes', agg: 'last', localDate: date, value: -30 })
    }
    if (o.today === false) return
    insert({ metric: 'daily_hrv', agg: 'last', localDate: TODAY, value: 44 })
    insert({ metric: 'resting_heart_rate', agg: 'last', localDate: TODAY, value: 55 })
    insert({ metric: 'respiratory_rate', agg: 'last', localDate: TODAY, value: o.respiratory ?? 14.2 })
  }

  it('scores today and carries its band, with HRV and resting heart rate beside it', () => {
    seedBaselines()
    const recovery = readRecovery(ctx())
    expect(recovery.index.value).not.toBeNull()
    expect(recovery.band).not.toBeNull()
    expect(recovery.missing).toBeNull()
    expect(recovery.hrv).toMatchObject({ value: 44, asOfDate: TODAY, partial: false })
    expect(recovery.restingHeartRate.value).toBe(55)
    expect(recovery.index).toMatchObject({ asOfDate: TODAY, unit: 'score' })
    expect(recovery.index.strip).toHaveLength(7)
  })

  it('shows yesterday\'s HRV and resting heart rate, saying so, before today\'s have synced', () => {
    seedBaselines({ today: false })
    const recovery = readRecovery(ctx())
    // 2026-08-19: 40 + 19 % 5 and 55 + 19 % 3, the values seedBaselines writes for that date.
    expect(recovery.hrv).toMatchObject({ value: 44, asOfDate: '2026-08-19' })
    expect(recovery.restingHeartRate).toMatchObject({ value: 56, asOfDate: '2026-08-19' })
  })

  it('shows yesterday\'s index, its band and no missing reasons, when today cannot be scored yet', () => {
    seedBaselines({ today: false })
    const recovery = readRecovery(ctx())
    expect(recovery.index.value).not.toBeNull()
    expect(recovery.index.asOfDate).toBe('2026-08-19')
    expect(recovery.band).not.toBeNull()
    expect(recovery.missing).toBeNull()
    // The strip is the index's week, still ending on today, where today is a gap.
    expect(recovery.index.strip.at(-1)).toEqual({ localDate: TODAY, value: null })
    expect(recovery.index.strip.at(-2)!.value).toBe(recovery.index.value)
  })

  it('leaves respiratory rate out on an ordinary day', () => {
    seedBaselines()
    expect(readRecovery(ctx()).respiratoryRate).toBeNull()
  })

  it('shows respiratory rate on a day it sits above its baseline', () => {
    seedBaselines({ respiratory: 19 })
    expect(readRecovery(ctx()).respiratoryRate).toMatchObject({ metric: 'respiratory_rate', value: 19 })
  })

  it('says why today could not be scored instead of inventing a score', () => {
    const recovery = readRecovery(ctx())
    expect(recovery.index.value).toBeNull()
    expect(recovery.band).toBeNull()
    expect(recovery.missing).toEqual(expect.arrayContaining(['hrv', 'restingHeartRate']))
  })
})

describe('standingOf', () => {
  const band = { center: 8000, low: 7000, high: 9000, thin: false }
  it('says within, above or below against the band', () => {
    expect(standingOf(8000, band, false)).toBe('within')
    expect(standingOf(9500, band, false)).toBe('above')
    expect(standingOf(6000, band, false)).toBe('below')
    expect(standingOf(9000, band, false)).toBe('within')
  })
  it('has no verdict without a value, without a band, on a thin band, or on a running day', () => {
    expect(standingOf(null, band, false)).toBeNull()
    expect(standingOf(8000, null, false)).toBeNull()
    expect(standingOf(8000, { ...band, thin: true }, false)).toBeNull()
    expect(standingOf(1000, band, true)).toBeNull()
  })
})

it('dailyFigure carries its standing', () => {
  for (const date of datesEnding('2026-08-19', 60)) insert({ metric: 'resting_heart_rate', agg: 'last', localDate: date, value: 55 + (Number(date.slice(-1)) % 3) })
  insert({ metric: 'resting_heart_rate', agg: 'last', localDate: TODAY, value: 70 })
  expect(dailyFigure(ctx(), { metric: 'resting_heart_rate', agg: 'last', on: TODAY, partial: false, asOfMs: null }).standing).toBe('above')
})

describe('readGlance', () => {
  it('answers a person with no data at all with every section present and empty, not an error', () => {
    const glance = readGlance(new PersonQuery(test.db, 'p1'), { today: TODAY, nowMs: NOW, nameOf: (id) => id })
    expect(glance).toMatchObject({ today: TODAY, sleep: null })
    // Nothing time-of-request in the body, or the route's content-hash ETag would never repeat.
    expect(glance).not.toHaveProperty('generatedAtMs')
    expect(glance.recovery.index.value).toBeNull()
    expect(glance.day.steps.value).toBeNull()
  })

  it('is what PersonQuery.glance returns', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(q.glance({ today: TODAY, nowMs: NOW })).toEqual(readGlance(q, { today: TODAY, nowMs: NOW, nameOf: (id) => id }))
  })
})
