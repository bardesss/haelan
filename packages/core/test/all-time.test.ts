import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sessions, sources } from '../src/db/schema/index.ts'
import { seedOverride } from '../src/testing/fixtures.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { MIN_RUN_DAYS } from '../src/api/runs.ts'
import { readAllTime } from '../src/query/allTime.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'x', displayName: 'Watch',
    kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => test.cleanup())

const insertDaily = (o: {
  localDate: string, value: number, metric?: string, source?: string, personId?: string,
}) => {
  test.db.insert(daily).values({
    personId: o.personId ?? 'p1', localDate: o.localDate, metric: o.metric ?? 'steps',
    agg: 'sum', source: o.source ?? 'merged', value: o.value, coverage: 0.9, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

/** `days` consecutive dates from `from`, one row each. */
const insertRun = (from: string, days: number, o: { metric?: string, source?: string, value?: number } = {}) => {
  const start = Date.parse(`${from}T00:00:00Z`)
  for (let i = 0; i < days; i += 1) {
    insertDaily({
      localDate: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      value: o.value ?? 1000, metric: o.metric, source: o.source,
    })
  }
}

const insertSession = (o: {
  kind: 'exercise' | 'sleep', localDate: string, id: string,
  minutes?: number, attrs?: Record<string, unknown>,
}) => {
  const startMs = Date.parse(`${o.localDate}T08:00:00Z`)
  test.db.insert(sessions).values({
    id: o.id, personId: 'p1', sourceId: 'watch', kind: o.kind, externalId: o.id,
    startMs, startOffsetMinutes: 0, endMs: startMs + (o.minutes ?? 60) * 60_000,
    endOffsetMinutes: 0, localDate: o.localDate,
    attrs: JSON.stringify(o.attrs ?? {}), rawPayloadId: null,
  }).run()
}

describe('readAllTime', () => {
  it('reads floors from the provider tier, where it is the only place it exists', () => {
    // The defect this exists to prevent: every other page in this app filters to `merged`, and
    // floors has no merged row at all - measured, 230 days of provider rows and none merged. A
    // merged-only reader reports no floors data while the archive holds two thirds of a year of
    // it, and nothing about the page looks broken.
    insertDaily({ metric: 'steps', source: 'merged', localDate: '2026-01-01', value: 9000 })
    insertDaily({ metric: 'floors', source: 'provider', localDate: '2026-01-01', value: 12 })

    const { records } = readAllTime(test.db, 'p1')
    expect(records.find((r) => r.metric === 'floors')).toMatchObject({ tier: 'provider', value: 12 })
    expect(records.find((r) => r.metric === 'steps')).toMatchObject({ tier: 'merged', value: 9000 })
  })

  it('prefers the merged tier when a metric has both', () => {
    // Merged is the reconciled figure; provider is what one upstream said. A household whose
    // device reports floors per source should get the merged answer without a code change,
    // which is why the tier is chosen by what exists rather than hardcoded per metric.
    insertDaily({ metric: 'floors', source: 'merged', localDate: '2026-01-01', value: 20 })
    insertDaily({ metric: 'floors', source: 'provider', localDate: '2026-01-01', value: 12 })

    expect(readAllTime(test.db, 'p1').records.find((r) => r.metric === 'floors'))
      .toMatchObject({ tier: 'merged', value: 20 })
  })

  it('leaves out a metric with no rows in either tier rather than showing a zero record', () => {
    insertDaily({ metric: 'steps', localDate: '2026-01-01', value: 9000 })
    const metrics = readAllTime(test.db, 'p1').records.map((r) => r.metric)
    expect(metrics).toEqual(['steps'])
  })

  it('gives the eddington number its own window, not the page span', () => {
    // The case the archive actually exhibits: the first row is from 2024 and steps do not start
    // until 2026, so E rests on a fraction of the span and must say which.
    insertDaily({ metric: 'total_calories', source: 'provider', localDate: '2024-08-25', value: 2000 })
    insertRun('2026-01-21', 20, { value: 12000 })

    const { span, eddington } = readAllTime(test.db, 'p1')
    expect(span.from).toBe('2024-08-25')
    expect(eddington).toMatchObject({ from: '2026-01-21', days: 20 })
    expect(eddington!.from).not.toBe(span.from)
  })

  it('answers no eddington number at all when there are no step rows', () => {
    insertDaily({ metric: 'floors', source: 'provider', localDate: '2026-01-01', value: 12 })
    expect(readAllTime(test.db, 'p1').eddington).toBeNull()
  })

  it('dates a record milestone to the day the record was set', () => {
    insertDaily({ metric: 'steps', localDate: '2026-01-01', value: 9000 })
    insertDaily({ metric: 'steps', localDate: '2026-02-14', value: 21000 })

    const record = readAllTime(test.db, 'p1').milestones
      .find((m) => m.kind === 'record' && m.metric === 'steps')
    expect(record).toMatchObject({ localDate: '2026-02-14' })
  })

  it('counts workouts and nights separately, never one as the other', () => {
    // The confusion that produced 65.10 TRIMP for a sleeping person in #191, in a new place.
    // Both kinds present and neither at its own next threshold: 60 workouts earns the 50th and
    // 60 nights earns nothing, because nights are marked every hundred. A reader summing the
    // two would see 120 and emit a 100th workout and a 100th night, neither of which happened.
    for (let i = 0; i < 60; i += 1) {
      insertSession({ kind: 'exercise', id: `e${i}`, localDate: '2026-01-01' })
      insertSession({ kind: 'sleep', id: `s${i}`, localDate: '2026-01-01' })
    }
    const counts = readAllTime(test.db, 'p1').milestones.filter((m) => m.kind === 'count')
    expect(counts).toEqual([{ kind: 'count', metric: 'exercise', count: 50, localDate: '2026-01-01' }])
  })

  it('does not count a session the person excluded', () => {
    // `sessions` is the ingested table, not a derived one: nothing deletes an excluded row, and
    // every other reader drops it at read through applyToSessions (sleepNights.ts:104,
    // deriveDay.ts:105). Counting raw rows here would credit somebody a 50th workout they had
    // already thrown out, and could name an excluded session as their first ever.
    for (let i = 0; i < 50; i += 1) {
      insertSession({ kind: 'exercise', id: `e${i}`, localDate: '2026-01-01' })
    }
    seedOverride(test.db, {
      personId: 'p1', scope: 'session', action: 'exclude',
      targetKey: JSON.stringify({ session: 'e49' }), reason: 'test',
    })

    const counts = readAllTime(test.db, 'p1').milestones.filter((m) => m.kind === 'count')
    expect(counts).toEqual([])
  })

  it('does not name an excluded session as the first recorded one', () => {
    insertSession({ kind: 'exercise', id: 'e-first', localDate: '2026-01-05' })
    insertSession({ kind: 'exercise', id: 'e-second', localDate: '2026-01-09' })
    seedOverride(test.db, {
      personId: 'p1', scope: 'session', action: 'exclude',
      targetKey: JSON.stringify({ session: 'e-first' }), reason: 'test',
    })

    const first = readAllTime(test.db, 'p1').milestones.find((m) => m.kind === 'first')
    expect(first).toMatchObject({ metric: 'exercise', localDate: '2026-01-09' })
  })

  it('marks the first recorded session of each kind', () => {
    insertSession({ kind: 'exercise', id: 'e1', localDate: '2026-01-27' })
    insertSession({ kind: 'sleep', id: 's1', localDate: '2026-01-24' })

    const firsts = readAllTime(test.db, 'p1').milestones.filter((m) => m.kind === 'first')
    expect(firsts).toEqual([
      { kind: 'first', metric: 'sleep', localDate: '2026-01-24' },
      { kind: 'first', metric: 'exercise', localDate: '2026-01-27' },
    ])
  })

  it('reads the three session records out of what the payloads recorded', () => {
    insertSession({
      kind: 'exercise', id: 'long', localDate: '2026-06-19', minutes: 264,
      attrs: { exerciseType: 'CARDIO_WORKOUT' },
    })
    insertSession({
      kind: 'exercise', id: 'far', localDate: '2026-09-12', minutes: 70,
      attrs: {
        exerciseType: 'RUNNING',
        metricsSummary: { distanceMillimeters: 12_850_000 },
        splits: [
          { splitType: 'DISTANCE', activeDuration: '308.5s', metricsSummary: { distanceMillimeters: 1_000_000 } },
          // Not a kilometre, so it must not win the pace record by being short.
          { splitType: 'DISTANCE', activeDuration: '120s', metricsSummary: { distanceMillimeters: 400_000 } },
        ],
      },
    })

    const { sessionRecords } = readAllTime(test.db, 'p1')
    expect(sessionRecords.find((r) => r.kind === 'longest')).toMatchObject({
      sessionId: 'long', exerciseType: 'CARDIO_WORKOUT', value: 264 * 60_000,
    })
    expect(sessionRecords.find((r) => r.kind === 'furthest')).toMatchObject({
      sessionId: 'far', value: 12_850_000,
    })
    expect(sessionRecords.find((r) => r.kind === 'fastest-km')).toMatchObject({
      sessionId: 'far', value: 308.5,
    })
  })

  it('does not let an excluded session hold a session record', () => {
    insertSession({ kind: 'exercise', id: 'excluded', localDate: '2026-01-01', minutes: 300 })
    insertSession({ kind: 'exercise', id: 'kept', localDate: '2026-01-02', minutes: 60 })
    seedOverride(test.db, {
      personId: 'p1', scope: 'session', action: 'exclude',
      targetKey: JSON.stringify({ session: 'excluded' }), reason: 'test',
    })

    expect(readAllTime(test.db, 'p1').sessionRecords.find((r) => r.kind === 'longest'))
      .toMatchObject({ sessionId: 'kept' })
  })

  it('names the source that set a daily record', () => {
    // The merged row carries the mix that produced it, so a record can say which device was on
    // the wrist that day rather than leaving an unattributed number.
    test.db.insert(daily).values({
      personId: 'p1', localDate: '2026-03-14', metric: 'steps', agg: 'sum', source: 'merged',
      value: 21_000, coverage: 0.9,
      sourceMix: JSON.stringify([{ source: 'watch', hours: 20 }]),
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()

    expect(readAllTime(test.db, 'p1').records.find((r) => r.metric === 'steps'))
      .toMatchObject({ sourceName: 'Watch' })
  })

  it('leaves a record unattributed rather than guessing when the row carries no mix', () => {
    // Provider rows never carry one - rollup.ts writes it null - and floors is provider only.
    insertDaily({ metric: 'floors', source: 'provider', localDate: '2026-01-01', value: 12 })
    expect(readAllTime(test.db, 'p1').records.find((r) => r.metric === 'floors'))
      .toMatchObject({ sourceName: null })
  })

  it('marks each millionth cumulative step on the day it was crossed', () => {
    // Implemented since the first version of this reader and never tested at any layer, which
    // is how its label reached the page interpolating a raw 1000000.
    insertDaily({ metric: 'steps', localDate: '2026-01-01', value: 600_000 })
    insertDaily({ metric: 'steps', localDate: '2026-01-02', value: 600_000 })
    insertDaily({ metric: 'steps', localDate: '2026-01-03', value: 100 })

    const crossings = readAllTime(test.db, 'p1').milestones
      .filter((m) => m.kind === 'count' && m.metric === 'steps')
    expect(crossings).toEqual([
      { kind: 'count', metric: 'steps', count: 1_000_000, localDate: '2026-01-02' },
    ])
  })

  it('reports the longest run of days carrying a reading', () => {
    insertRun('2026-01-01', MIN_RUN_DAYS + 3)
    const run = readAllTime(test.db, 'p1').milestones.find((m) => m.kind === 'run')
    expect(run).toMatchObject({ days: MIN_RUN_DAYS + 3, localDate: '2026-01-10' })
  })

  it('counts the run over worn days, not over days some provider filed a row for', () => {
    // Measured against the real archive, and the reason this milestone exists at all: the
    // provider tier carries a total_calories row on EVERY day of the span, worn or not, so a run
    // over any row at all answers 751 days - the length of the archive, dressed up as a habit.
    // Over merged rows it answers 732, which is the same thing. Only the step history, which
    // exists when somebody carried the device, answers the question the page is asking.
    insertRun('2026-01-01', 40, { metric: 'total_calories', source: 'provider' })
    insertRun('2026-01-01', MIN_RUN_DAYS + 1, { metric: 'steps' })

    const run = readAllTime(test.db, 'p1').milestones.find((m) => m.kind === 'run')
    expect(run).toMatchObject({ days: MIN_RUN_DAYS + 1 })
  })

  it('withholds the run below the floor rather than naming a short one', () => {
    insertRun('2026-01-01', MIN_RUN_DAYS - 1)
    expect(readAllTime(test.db, 'p1').milestones.find((m) => m.kind === 'run')).toBeUndefined()
  })

  it('answers a person with no rows at all rather than throwing', () => {
    const all = readAllTime(test.db, 'p1')
    expect(all.records).toEqual([])
    expect(all.eddington).toBeNull()
    expect(all.milestones).toEqual([])
    expect(all.span.days).toBe(0)
  })

  it('never reads another person’s rows', () => {
    seedPerson(test.db, 'p2')
    insertDaily({ metric: 'steps', localDate: '2026-01-01', value: 9000 })
    insertDaily({ metric: 'steps', localDate: '2026-01-02', value: 99000, personId: 'p2' })

    expect(readAllTime(test.db, 'p1').records.find((r) => r.metric === 'steps'))
      .toMatchObject({ value: 9000 })
  })
})
