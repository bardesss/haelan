import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, insertSample, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { ConfigError } from '../src/errors.ts'
import { daily, sessions, sources } from '../src/db/schema/index.ts'
import type { SessionKind } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

let test: TestDatabase
let query: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  query = new PersonQuery(test.db, 'p1')
})
afterEach(() => test.cleanup())

const insertDaily = (o: {
  localDate: string, value: number | null, metric?: string, agg?: string,
  source?: string, coverage?: number | null, personId?: string, updatedAtMs?: number | null,
}) => {
  test.db.insert(daily).values({
    personId: o.personId ?? 'p1',
    localDate: o.localDate,
    metric: o.metric ?? 'steps',
    agg: o.agg ?? 'sum',
    source: o.source ?? 'merged',
    value: o.value,
    coverage: o.coverage === undefined ? 0.9 : o.coverage,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
    updatedAtMs: o.updatedAtMs === undefined ? null : o.updatedAtMs,
  }).run()
}

const insertSource = (id: string, personId = 'p1') =>
  test.db.insert(sources).values({
    id, personId, externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
  }).run()

const addSample = (o: {
  utcMs: number, value: number, personId?: string, sourceId?: string,
}) =>
  insertSample(test.db, {
    personId: o.personId ?? 'p1', sourceId: o.sourceId ?? 'p1-watch', metric: 'heart_rate',
    utcMs: o.utcMs, agg: 'mean', value: o.value,
  })

const insertSession = (o: {
  id: string, kind: SessionKind, personId?: string, sourceId?: string,
  startMs: number, endMs: number, localDate: string,
}) =>
  test.db.insert(sessions).values({
    id: o.id, personId: o.personId ?? 'p1', sourceId: o.sourceId ?? 'p1-watch', kind: o.kind,
    externalId: o.id, startMs: o.startMs, startOffsetMinutes: 0, endMs: o.endMs,
    endOffsetMinutes: 0, localDate: o.localDate, attrs: '{}', rawPayloadId: null,
  }).run()

describe('PersonQuery.series', () => {
  it('returns the days in the range, oldest first', () => {
    insertDaily({ localDate: '2026-08-03', value: 300 })
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-02', value: 200 })

    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-03' })
    expect(points.map((p) => p.localDate)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(points.map((p) => p.value)).toEqual([100, 200, 300])
  })

  it('includes both ends of the range', () => {
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-05', value: 500 })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points).toHaveLength(2)
  })

  it('excludes days outside the range', () => {
    insertDaily({ localDate: '2026-07-31', value: 1 })
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-06', value: 1 })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points.map((p) => p.value)).toEqual([100])
  })

  it('reads the merged row by default, because that is the answer to what happened', () => {
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'watch' })
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([900])
  })

  it('reads one source when asked, so provenance stays reachable', () => {
    // Registered as well as written to `daily`, because series() now refuses a source this
    // person does not have. A row whose source is in no registry cannot arise from a real
    // derivation either: mapping registers the device before it writes a thing under its id.
    insertSource('watch')
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'watch' })
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01', source: 'watch' })
    expect(points.map((p) => p.value)).toEqual([400])
  })

  it('separates aggregates of the same metric', () => {
    insertDaily({ localDate: '2026-08-01', value: 52, metric: 'heart_rate', agg: 'min' })
    insertDaily({ localDate: '2026-08-01', value: 88, metric: 'heart_rate', agg: 'max' })
    const { points } = query.series({ metric: 'heart_rate', agg: 'max', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([88])
  })

  it('carries coverage through, including a null one', () => {
    insertDaily({ localDate: '2026-08-01', value: 480, metric: 'sleep_asleep_minutes', coverage: null })
    const { points } = query.series({ metric: 'sleep_asleep_minutes', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points[0]?.coverage).toBeNull()
  })

  it('drops a row with no value, because that is not a measurement', () => {
    // Nothing writes one today: every producer skips a null before it builds a row. The guard
    // is here so a future producer that does cannot silently put a hole in a mean.
    insertDaily({ localDate: '2026-08-01', value: null })
    insertDaily({ localDate: '2026-08-02', value: 200 })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-02' })
    expect(points.map((p) => p.value)).toEqual([200])
  })

  it('returns an empty series rather than throwing when there is nothing', () => {
    expect(query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' }).points).toEqual([])
  })

  it('falls back to the provider row for a metric that has no merged one', () => {
    // total_calories and floors are written only as provider rows: Google reconciles them
    // itself and there is no sample underneath either for a merge to work from. Asking what
    // happened that day has to answer with the row that says it.
    insertDaily({ localDate: '2026-08-01', value: 2200, metric: 'total_calories', source: 'provider' })
    const { points } = query.series({ metric: 'total_calories', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([2200])
    expect(points.map((p) => p.source)).toEqual(['provider'])
  })

  it('falls back per row, so one stray merged row cannot hide a provider series', () => {
    insertDaily({ localDate: '2026-08-01', value: 2200, metric: 'total_calories', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 2300, metric: 'total_calories', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 2350, metric: 'total_calories', source: 'merged' })
    const { points } = query.series({ metric: 'total_calories', agg: 'sum', from: '2026-08-01', to: '2026-08-02' })
    expect(points.map((p) => p.value)).toEqual([2200, 2350])
    expect(points.map((p) => p.source)).toEqual(['provider', 'merged'])
  })

  it('ignores the provider row on a day that has a merged one', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'provider' })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([900])
  })

  // The HTTP surface's ETag needs the newest updated_at_ms among the rows an answer drew on,
  // and daily is the only reader over that column anywhere in core.
  it('carries updatedAtMs through, including a null one', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, updatedAtMs: 1_770_000_000_000 })
    insertDaily({ localDate: '2026-08-02', value: 800 })
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-02' })
    expect(points[0]?.updatedAtMs).toBe(1_770_000_000_000)
    expect(points[1]?.updatedAtMs).toBeNull()
  })

  it('returns only merged rows when merged is named, so provenance stays askable', () => {
    // Not the same question as the default. This one asks which days we reconciled ourselves.
    insertDaily({ localDate: '2026-08-01', value: 2200, metric: 'total_calories', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 2350, metric: 'total_calories', source: 'merged' })
    const { points } = query.series({
      metric: 'total_calories', agg: 'sum', from: '2026-08-01', to: '2026-08-02', source: 'merged',
    })
    expect(points.map((p) => p.value)).toEqual([2350])
  })
})

describe('PersonQuery.series, the metric a phone rolls up instead of a daily type', () => {
  it('answers daily_hrv from the rolled up hrv when nothing wrote the daily name', () => {
    // The measured shape of a companion instance: `hrv` has rows, `daily_hrv` has none, because
    // Health Connect computes no daily HRV summary and the phone has no Google daily type to
    // send. The card asks for the daily name and used to get an empty series while the number
    // sat one name away, already derived.
    insertDaily({ localDate: '2026-08-01', value: 42, metric: 'hrv', agg: 'mean', source: 'merged' })

    const { points } = query.series({ metric: 'daily_hrv', agg: 'last', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([42])
  })

  it('reads the merged hrv rather than one device, the same choice every series makes', () => {
    insertSource('phone')
    insertDaily({ localDate: '2026-08-01', value: 30, metric: 'hrv', agg: 'mean', source: 'phone' })
    insertDaily({ localDate: '2026-08-01', value: 42, metric: 'hrv', agg: 'mean', source: 'merged' })

    const { points } = query.series({ metric: 'daily_hrv', agg: 'last', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([42])
    expect(points.map((p) => p.source)).toEqual(['merged'])
  })

  it('does not take the fallback when the daily row exists, so a Google instance is unchanged', () => {
    // The one that must not move. daily_hrv is the device's own summary, and a fallback that
    // outranked it would answer a question about the watch with a number about the phone.
    insertDaily({ localDate: '2026-08-01', value: 55, metric: 'daily_hrv', agg: 'last', source: 'provider' })
    insertDaily({ localDate: '2026-08-01', value: 42, metric: 'hrv', agg: 'mean', source: 'merged' })

    const { points } = query.series({ metric: 'daily_hrv', agg: 'last', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([55])
    expect(points.map((p) => p.source)).toEqual(['provider'])
  })

  it('keeps a day with a daily row and fills the day without one, in the same series', () => {
    insertDaily({ localDate: '2026-08-01', value: 55, metric: 'daily_spo2', agg: 'last', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 97, metric: 'spo2', agg: 'mean', source: 'merged' })

    const { points } = query.series({ metric: 'daily_spo2', agg: 'last', from: '2026-08-01', to: '2026-08-02' })
    expect(points.map((p) => p.value)).toEqual([55, 97])
  })

  it('answers nothing for respiratory_rate, because the phone only has the night', () => {
    // The asymmetry, held on purpose. Google summarises a whole day of breathing; the phone
    // summarises the night, under `sleep_respiratory_rate`. Mapping the day's card onto the
    // night's number would answer the question it asked with a different one.
    insertDaily({ localDate: '2026-08-01', value: 14, metric: 'sleep_respiratory_rate', agg: 'last', source: 'merged' })

    const { points } = query.series({ metric: 'respiratory_rate', agg: 'last', from: '2026-08-01', to: '2026-08-01' })
    expect(points).toEqual([])
  })
})

describe('PersonQuery.series with a point budget', () => {
  it('thins on the index, keeping the first and last local date', () => {
    for (let day = 1; day <= 20; day += 1) {
      insertDaily({ localDate: `2026-08-${String(day).padStart(2, '0')}`, value: day })
    }
    const { points } = query.series({
      metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-20', points: 5,
    })
    expect(points.length).toBeLessThanOrEqual(5)
    expect(points[0]?.localDate).toBe('2026-08-01')
    expect(points.at(-1)?.localDate).toBe('2026-08-20')
  })

  it('returns every point when no budget is given', () => {
    for (let day = 1; day <= 5; day += 1) {
      insertDaily({ localDate: `2026-08-0${day}`, value: day })
    }
    const { points } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points).toHaveLength(5)
  })

  // The spec is explicit that reduction is not optional politeness: a client handed 200 points
  // where 365 existed, with no way to know, cannot state the basis of what it drew. series used
  // to discard thin's reduction outright; it now answers the same shape intraday already does.
  it('reports the reduction when it thins, matching intraday\'s shape', () => {
    for (let day = 1; day <= 20; day += 1) {
      insertDaily({ localDate: `2026-08-${String(day).padStart(2, '0')}`, value: day })
    }
    const { reduction } = query.series({
      metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-20', points: 5,
    })
    expect(reduction).toMatchObject({ method: 'lttb', from: 20 })
  })

  it('reports no reduction when nothing was thinned', () => {
    for (let day = 1; day <= 5; day += 1) {
      insertDaily({ localDate: `2026-08-0${day}`, value: day })
    }
    const { reduction } = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(reduction).toBeNull()
  })
})

describe('PersonQuery.intraday', () => {
  const NINE_AM = Date.UTC(2026, 7, 22, 9, 0)

  it("reads the person's own samples for the local day", () => {
    insertSource('p1-watch')
    addSample({ utcMs: NINE_AM, value: 62 })
    const out = query.intraday({ metric: 'heart_rate', localDate: '2026-08-22' })
    expect(out.points).toHaveLength(1)
    expect(out.points[0]?.mean).toBe(62)
  })

  it('is bound to its own person rather than one sharing the same instant', () => {
    seedPerson(test.db, 'other')
    insertSource('p1-watch', 'p1')
    insertSource('other-watch', 'other')
    addSample({ utcMs: NINE_AM, value: 62, personId: 'p1', sourceId: 'p1-watch' })
    addSample({ utcMs: NINE_AM, value: 999, personId: 'other', sourceId: 'other-watch' })

    const out = query.intraday({ metric: 'heart_rate', localDate: '2026-08-22' })
    expect(out.points.map((p) => p.mean)).toEqual([62])
  })

  it('refuses a malformed local date', () => {
    expect(() => query.intraday({ metric: 'heart_rate', localDate: 'not-a-date' })).toThrow(ConfigError)
  })

  // Every other reader validates its metric through requireMetricAndAgg. intraday called only
  // requireDate, so a typo answered with an empty result rather than an error: an emptiness
  // indistinguishable from "this person has no data", which in M4 becomes an agent stating a
  // false thing about a health record.
  it('refuses a metric the catalogue does not declare', () => {
    expect(() => query.intraday({ metric: 'not_a_metric', localDate: '2026-08-22' })).toThrow(ConfigError)
  })
})

describe('PersonQuery.sleepNights', () => {
  const BEDTIME = Date.UTC(2026, 7, 21, 21, 0)
  const H = 3_600_000

  it("reads the person's own nights in range", () => {
    insertSource('p1-watch')
    insertSession({
      id: 'n1', kind: 'sleep', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22',
    })
    const nights = query.sleepNights({ from: '2026-08-22', to: '2026-08-22' })
    expect(nights).toHaveLength(1)
    expect(nights[0]?.sessionIds).toEqual(['n1'])
  })

  it('is bound to its own person rather than one sleeping the same night', () => {
    seedPerson(test.db, 'other')
    insertSource('p1-watch', 'p1')
    insertSource('other-watch', 'other')
    insertSession({
      id: 'n1', kind: 'sleep', personId: 'p1', sourceId: 'p1-watch',
      startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22',
    })
    insertSession({
      id: 'n2', kind: 'sleep', personId: 'other', sourceId: 'other-watch',
      startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22',
    })

    const nights = query.sleepNights({ from: '2026-08-22', to: '2026-08-22' })
    expect(nights).toHaveLength(1)
    expect(nights[0]?.sessionIds).toEqual(['n1'])
  })

  it('refuses a reversed range', () => {
    expect(() => query.sleepNights({ from: '2026-08-31', to: '2026-08-01' })).toThrow(ConfigError)
  })
})

describe('PersonQuery.sessions', () => {
  const START = Date.UTC(2026, 7, 21, 17, 0)
  const H = 3_600_000

  it("reads the person's own sessions of the requested kind", () => {
    insertSource('p1-watch')
    insertSession({
      id: 'run', kind: 'exercise', startMs: START, endMs: START + H, localDate: '2026-08-21',
    })
    const out = query.sessions({ kind: 'exercise', from: '2026-08-21', to: '2026-08-21' })
    expect(out.map((s) => s.id)).toEqual(['run'])
  })

  it('is bound to its own person rather than one exercising the same day', () => {
    seedPerson(test.db, 'other')
    insertSource('p1-watch', 'p1')
    insertSource('other-watch', 'other')
    insertSession({
      id: 'run', kind: 'exercise', personId: 'p1', sourceId: 'p1-watch',
      startMs: START, endMs: START + H, localDate: '2026-08-21',
    })
    insertSession({
      id: 'other-run', kind: 'exercise', personId: 'other', sourceId: 'other-watch',
      startMs: START, endMs: START + H, localDate: '2026-08-21',
    })

    const out = query.sessions({ kind: 'exercise', from: '2026-08-21', to: '2026-08-21' })
    expect(out.map((s) => s.id)).toEqual(['run'])
  })

  it('refuses a reversed range', () => {
    expect(() => query.sessions({ kind: 'exercise', from: '2026-08-31', to: '2026-08-01' }))
      .toThrow(ConfigError)
  })

  // kind is typed as 'sleep' | 'exercise', but the two direct consumers, an HTTP query string
  // and a language model's tool arguments, both sit outside the type system: a caller passing
  // anything else has the same shape at runtime as the metric typo requireMetricAndAgg exists to
  // catch, so it gets the same treatment rather than reading the sessions table for a kind that
  // can never match a row and calling the empty result an answer.
  it('refuses a kind other than sleep or exercise', () => {
    expect(() => query.sessions({
      kind: 'workout' as unknown as 'exercise', from: '2026-08-01', to: '2026-08-01',
    })).toThrow(ConfigError)
  })
})

describe('PersonQuery.trend', () => {
  const seedFlat = (personId: string, value: number) => {
    for (let day = 1; day <= 10; day += 1) {
      insertDaily({ localDate: `2026-08-${String(day).padStart(2, '0')}`, value, personId })
    }
  }

  it("smooths the person's own series", () => {
    seedFlat('p1', 80)
    const out = query.trend({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-10' })
    expect(out.every((p) => p.value === 80)).toBe(true)
  })

  it('is bound to its own person rather than one with wildly different readings', () => {
    seedPerson(test.db, 'other')
    seedFlat('p1', 80)
    seedFlat('other', 999)
    const out = query.trend({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-10' })
    expect(out.every((p) => p.value === 80)).toBe(true)
  })

  it('refuses an unknown metric', () => {
    expect(() => query.trend({ metric: 'sleep', agg: 'sum', from: '2026-08-01', to: '2026-08-10' }))
      .toThrow(ConfigError)
  })
})

describe('PersonQuery argument validation', () => {
  // Every emptiness these would otherwise return is indistinguishable from "this person has no
  // data", which in M4 becomes an agent stating a false thing about a health record.
  it('refuses an unpadded date rather than silently comparing it as a string', () => {
    // '2026-08-05' >= '2026-8-1' is false, so the whole month would come back empty.
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2026-8-1', to: '2026-08-31' }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-8-1' })).toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-8-1', to: '2026-08-31' }))
      .toThrow(ConfigError)
  })

  it('names the offending value, so a caller can say which argument was wrong', () => {
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-8-1' })).toThrow(/2026-8-1/)
  })

  it('refuses a reversed range rather than returning nothing', () => {
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2026-08-31', to: '2026-08-01' }))
      .toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-31', to: '2026-08-01' }))
      .toThrow(ConfigError)
  })

  it('refuses a plainly malformed date in every method', () => {
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: 'last tuesday', to: '2026-08-31' }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: 'last tuesday' })).toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: 'last tuesday' }))
      .toThrow(ConfigError)
  })

  it('refuses a metric the catalogue does not declare', () => {
    // 'sleep' is the data type id, not a metric. It has no rows and never will.
    expect(() => query.series({ metric: 'sleep', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'sleep', agg: 'sum', on: '2026-08-07' })).toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'sleep', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(ConfigError)
  })

  it('refuses an aggregate the metric does not declare', () => {
    // Summing heart rate is not a number anyone means, and 'avg' is not what the column is called.
    expect(() => query.series({ metric: 'heart_rate', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(ConfigError)
    expect(() => query.series({ metric: 'heart_rate', agg: 'avg', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(/mean/)
  })
})

// `source` was the last parameter on this surface still answering a value it could not honour
// with 200 and an empty result. Every read that takes one narrows with an equality test, so a
// typo matched no row and came back indistinguishable from "this person has no data" for the
// range asked for, which in M4 becomes an agent stating a false thing about a health record.
describe('PersonQuery source validation', () => {
  const RANGE = { metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }

  it('refuses an unknown source on every daily backed read', () => {
    insertSource('watch')
    expect(() => query.series({ ...RANGE, source: 'wtach' })).toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-07', source: 'wtach' }))
      .toThrow(ConfigError)
    expect(() => query.comparePeriods({ ...RANGE, source: 'wtach' })).toThrow(ConfigError)
    expect(() => query.trend({ ...RANGE, source: 'wtach' })).toThrow(ConfigError)
  })

  it('refuses an unknown source on every tier 2 read', () => {
    insertSource('p1-watch')
    expect(() => query.intraday({ metric: 'heart_rate', localDate: '2026-08-22', sourceId: 'p1-wtach' }))
      .toThrow(ConfigError)
    expect(() => query.sleepNights({ from: '2026-08-01', to: '2026-08-07', sourceId: 'p1-wtach' }))
      .toThrow(ConfigError)
    expect(() => query.sessions({ kind: 'exercise', from: '2026-08-01', to: '2026-08-07', sourceId: 'p1-wtach' }))
      .toThrow(ConfigError)
  })

  it('names the value it refused and what this person actually has', () => {
    insertSource('watch')
    expect(() => query.series({ ...RANGE, source: 'wtach' })).toThrow(/'wtach'/)
    expect(() => query.series({ ...RANGE, source: 'wtach' })).toThrow(/watch/)
  })

  it('says plainly when the person has no sources at all, rather than listing nothing', () => {
    expect(() => query.intraday({ metric: 'heart_rate', localDate: '2026-08-22', sourceId: 'watch' }))
      .toThrow(/no sources at all/)
  })

  // The registry, not the rows in range: a device that reported nothing on the days asked for is
  // a real source whose answer is genuinely empty, and refusing it would turn a true empty result
  // into an error.
  it('accepts a registered source with no rows in the range asked for', () => {
    insertSource('watch')
    expect(query.series({ ...RANGE, source: 'watch' }).points).toEqual([])
  })

  it('keeps accepting merged and provider on a daily backed read, since neither is a device', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    insertDaily({ localDate: '2026-08-02', value: 800, source: 'provider' })
    expect(query.series({ ...RANGE, source: 'merged' }).points.map((p) => p.value)).toEqual([900])
    expect(query.series({ ...RANGE, source: 'provider' }).points.map((p) => p.value)).toEqual([800])
  })

  // `samples`, `sessions` and `session_segments` are the normalized tier, written per device.
  // Nothing there ever carries a merge's name, so asking for one is the same empty answer a typo
  // gave, and gets the same refusal.
  it('refuses merged on a tier 2 read, where no row can ever carry it', () => {
    insertSource('p1-watch')
    expect(() => query.intraday({ metric: 'heart_rate', localDate: '2026-08-22', sourceId: 'merged' }))
      .toThrow(ConfigError)
  })

  // The registry is read per person, so this is the isolation rule showing up in a refusal: the
  // id exists, and it still is not one of this person's to ask about.
  it("refuses another person's source id", () => {
    seedPerson(test.db, 'other')
    insertSource('other-watch', 'other')
    expect(() => query.series({ ...RANGE, source: 'other-watch' })).toThrow(ConfigError)
  })
})

describe('PersonQuery.baseline', () => {
  const seedRun = (fromDay: number, count: number, value: (at: number) => number) => {
    for (let at = 0; at < count; at += 1) {
      insertDaily({ localDate: `2026-08-${String(fromDay + at).padStart(2, '0')}`, value: value(at) })
    }
  }

  it('averages the window ending the day before the date asked about', () => {
    // Five days at 10, then a wild reading on the sixth. The baseline for the sixth must not
    // contain it, or the reading would be judged against a centre it moved itself.
    seedRun(1, 5, () => 10)
    insertDaily({ localDate: '2026-08-06', value: 1000 })

    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-06', windowDays: 5 })
    expect(baseline?.center).toBeCloseTo(10, 10)
    expect(baseline?.n).toBe(5)
  })

  it('reaches back exactly the window it was given', () => {
    seedRun(1, 10, (at) => at)
    // Window of 3 ending on the day before the 8th: the 5th, 6th and 7th, values 4, 5 and 6.
    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-08', windowDays: 3 })
    expect(baseline?.n).toBe(3)
    expect(baseline?.center).toBeCloseTo(5, 10)
  })

  it('defaults to the stated window', () => {
    seedRun(1, 10, () => 100)
    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' })
    // The default reaches far enough back to include all ten days and finds no more.
    expect(baseline?.n).toBe(10)
  })

  it('marks a short history thin rather than pretending', () => {
    seedRun(1, 3, () => 100)
    expect(query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' })?.thin).toBe(true)
  })

  it('returns null when there is no history at all', () => {
    expect(query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' })).toBeNull()
  })

  it('refuses a windowDays that is not a positive integer, rather than computing a reversed range', () => {
    // windowDays: 0 used to compute a `from` after `to` and throw a ConfigError naming dates the
    // caller never passed. The caller passed windowDays; that is what the message should name.
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-10', windowDays: 0 }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-10', windowDays: 0 }))
      .toThrow(/windowDays/)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-10', windowDays: -5 }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-10', windowDays: 1.5 }))
      .toThrow(ConfigError)
  })

  it('counts only the days that have a row, so a gap is absent rather than zero', () => {
    insertDaily({ localDate: '2026-08-01', value: 10 })
    insertDaily({ localDate: '2026-08-05', value: 20 })
    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-10', windowDays: 60 })
    expect(baseline?.n).toBe(2)
    expect(baseline?.center).toBeCloseTo(15, 10)
  })

  it('drops barely worn days for a metric whose coverage says something', () => {
    // A watch worn only in the mornings gives a day at 0.2 coverage whose mean is a systematic
    // undercount, not a low reading. Left in, the centre sinks and the first properly worn day
    // scores a large positive z, which is a wear artefact reported as a health signal.
    for (let at = 0; at < 10; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 60, metric: 'heart_rate', agg: 'mean', coverage: 0.9,
      })
      insertDaily({
        localDate: `2026-08-${String(11 + at).padStart(2, '0')}`,
        value: 30, metric: 'heart_rate', agg: 'mean', coverage: 0.2,
      })
    }
    const baseline = query.baseline({ metric: 'heart_rate', agg: 'mean', on: '2026-08-21', windowDays: 20 })
    expect(baseline?.n).toBe(10)
    expect(baseline?.center).toBeCloseTo(60, 10)
  })

  it('keeps every day for a metric whose coverage is not a quality signal', () => {
    // resting_heart_rate arrives once a day, so a perfect day reads 1/24. Dropping those would
    // leave the metric behind the product's flagship example question with no baseline at all.
    for (let at = 0; at < 20; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 58, metric: 'resting_heart_rate', agg: 'last', coverage: 1 / 24,
      })
    }
    const baseline = query.baseline({ metric: 'resting_heart_rate', agg: 'last', on: '2026-08-21', windowDays: 20 })
    expect(baseline?.n).toBe(20)
    expect(baseline?.thin).toBe(false)
  })

  it('keeps a day whose coverage is null, because null is not a zero', () => {
    for (let at = 0; at < 20; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 420, metric: 'sleep_asleep_minutes', coverage: null,
      })
    }
    const baseline = query.baseline({ metric: 'sleep_asleep_minutes', agg: 'sum', on: '2026-08-21', windowDays: 20 })
    expect(baseline?.n).toBe(20)
  })
})

describe('PersonQuery.comparePeriods', () => {
  const seedWeek = (fromDay: number, value: number, coverage: number | null = 0.9) => {
    for (let at = 0; at < 7; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(fromDay + at).padStart(2, '0')}`, value, coverage,
      })
    }
  }

  it('compares a week against the week immediately before it', () => {
    seedWeek(1, 80)
    seedWeek(8, 100)
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.current).toBeCloseTo(100, 10)
    expect(insight.previous).toBeCloseTo(80, 10)
    expect(insight.delta).toBeCloseTo(20, 10)
    expect(insight.periodDays).toBe(7)
    expect(insight.suppressed).toBe(false)
  })

  it('suppresses when the current week is full of holes', () => {
    seedWeek(1, 80)
    insertDaily({ localDate: '2026-08-08', value: 100 })
    insertDaily({ localDate: '2026-08-09', value: 100 })
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-days')
    expect(insight.delta).toBeNull()
  })

  it('does not suppress a sleep comparison for having null coverage', () => {
    // Every sleep row carries a null coverage on purpose. If that counted as zero, the sleep
    // page would never show an insight at all, which is the opposite of what the rule is for.
    for (let at = 0; at < 7; at += 1) {
      insertDaily({ localDate: `2026-08-${String(1 + at).padStart(2, '0')}`, value: 420, metric: 'sleep_asleep_minutes', coverage: null })
      insertDaily({ localDate: `2026-08-${String(8 + at).padStart(2, '0')}`, value: 480, metric: 'sleep_asleep_minutes', coverage: null })
    }
    const insight = query.comparePeriods({ metric: 'sleep_asleep_minutes', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.suppressed).toBe(false)
    expect(insight.delta).toBeCloseTo(60, 10)
  })

  it('measures the previous period as the same number of days, immediately before', () => {
    // A three day window ending the 10th compares against the 5th to the 7th, not against a
    // week or a calendar month.
    for (const day of [5, 6, 7]) insertDaily({ localDate: `2026-08-0${day}`, value: 10 })
    for (const day of [8, 9]) insertDaily({ localDate: `2026-08-0${day}`, value: 20 })
    insertDaily({ localDate: '2026-08-10', value: 20 })
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-10' })
    expect(insight.periodDays).toBe(3)
    expect(insight.previousDays).toBe(3)
    expect(insight.previous).toBeCloseTo(10, 10)
    expect(insight.current).toBeCloseTo(20, 10)
  })

  it('does not suppress a once-a-day metric for reading one hour in twenty four', () => {
    // resting_heart_rate arrives once a day, so coverage is 1/24 = 0.0417 on a perfect week.
    // Judged against a threshold of 0.5 it was suppressed always and forever, which blanked the
    // whole Recovery page and the metric behind the product's own flagship example question.
    for (let at = 0; at < 7; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 58, metric: 'resting_heart_rate', agg: 'last', coverage: 1 / 24,
      })
      insertDaily({
        localDate: `2026-08-${String(8 + at).padStart(2, '0')}`,
        value: 62, metric: 'resting_heart_rate', agg: 'last', coverage: 1 / 24,
      })
    }
    const insight = query.comparePeriods({
      metric: 'resting_heart_rate', agg: 'last', from: '2026-08-08', to: '2026-08-14',
    })
    expect(insight.suppressed).toBe(false)
    expect(insight.delta).toBeCloseTo(4, 10)
    // Null rather than 0.0417: the number exists in the row and means nothing about quality here.
    expect(insight.currentCoverage).toBeNull()
  })

  it('still suppresses a continuously sampled metric that was barely worn', () => {
    // heart_rate is sampled all day, so 0.1 is a watch worn for a couple of hours and its mean
    // is an artefact. The gate has to keep working exactly where coverage does mean something.
    for (let at = 0; at < 7; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 58, metric: 'heart_rate', agg: 'mean', coverage: 0.1,
      })
      insertDaily({
        localDate: `2026-08-${String(8 + at).padStart(2, '0')}`,
        value: 62, metric: 'heart_rate', agg: 'mean', coverage: 0.1,
      })
    }
    const insight = query.comparePeriods({
      metric: 'heart_rate', agg: 'mean', from: '2026-08-08', to: '2026-08-14',
    })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-coverage')
    expect(insight.currentCoverage).toBeCloseTo(0.1, 10)
  })

  it('says which two ranges it compared, so nothing downstream re-derives them', () => {
    seedWeek(1, 80)
    seedWeek(8, 100)
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.currentRange).toEqual({ from: '2026-08-08', to: '2026-08-14' })
    expect(insight.previousRange).toEqual({ from: '2026-08-01', to: '2026-08-07' })
    expect(insight.currentCoverage).toBeCloseTo(0.9, 10)
    expect(insight.previousCoverage).toBeCloseTo(0.9, 10)
  })

  it('still says what it compared when it refuses, because that is the explanation', () => {
    seedWeek(1, 80)
    insertDaily({ localDate: '2026-08-08', value: 100 })
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.suppressed).toBe(true)
    expect(insight.currentRange).toEqual({ from: '2026-08-08', to: '2026-08-14' })
    expect(insight.previousRange).toEqual({ from: '2026-08-01', to: '2026-08-07' })
    expect(insight.currentDays).toBe(1)
    expect(insight.previousDays).toBe(7)
    expect(insight.currentCoverage).toBeCloseTo(0.9, 10)
    expect(insight.delta).toBeNull()
  })

  // The comparison period is derived, never supplied. Stepping a wide range back by its own
  // length lands outside the calendar, and the refusal used to name that derived date: a caller
  // who sent 1000-01-01 read `got '-008000-01'` and had a range to find in their own code that
  // was not in it.
  it('names the range the caller passed when the period before it falls off the calendar', () => {
    const wide = { metric: 'steps', agg: 'sum', from: '1000-01-01', to: '9999-12-31' }
    expect(() => query.comparePeriods(wide)).toThrow(ConfigError)
    expect(() => query.comparePeriods(wide)).toThrow(/1000-01-01/)
    expect(() => query.comparePeriods(wide)).toThrow(/9999-12-31/)
    // And says where the range it is refusing came from, since the caller never wrote that one.
    expect(() => query.comparePeriods(wide)).toThrow(/period of equal length immediately before/)
    expect(() => query.comparePeriods(wide)).not.toThrow(/-008000/)
  })
})

describe('PersonQuery date validation, out of range components', () => {
  // The format check alone lets '2026-13-45' through: it is four digits, two, two. The three
  // methods then diverge, which is the exact failure the padded-month check was added to end.
  // series compares it as a string and finds nothing, while the other two hand it to Date.parse,
  // get NaN, and throw a RangeError from three frames down. The consumers here are an HTTP query
  // string and a language model picking tool arguments, so an off by one month is ordinary.
  const nonsense = ['2026-13-01', '2026-00-15', '2026-02-30', '2026-01-32', '2026-01-00']

  it('refuses an impossible month or day from series', () => {
    for (const on of nonsense) {
      expect(() => query.series({ metric: 'steps', agg: 'sum', from: on, to: '2026-08-28' }), on)
        .toThrow(ConfigError)
    }
  })

  it('refuses an impossible month or day from baseline', () => {
    for (const on of nonsense) {
      expect(() => query.baseline({ metric: 'steps', agg: 'sum', on }), on).toThrow(ConfigError)
    }
  })

  it('refuses an impossible month or day from comparePeriods', () => {
    for (const on of nonsense) {
      expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: on, to: '2026-08-28' }), on)
        .toThrow(ConfigError)
    }
  })

  it('still accepts a real leap day, so the check rejects only what the calendar rejects', () => {
    // 2028 is a leap year and 2026 is not. A round trip check that simply reformatted the parsed
    // date would pass both, so this is what proves it compares against the calendar.
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2028-02-29', to: '2028-03-01' }))
      .not.toThrow()
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2026-02-29', to: '2026-03-01' }))
      .toThrow(ConfigError)
  })
})
