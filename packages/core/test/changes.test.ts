import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readChanges } from '../src/query/changes.ts'
import { daily } from '../src/db/schema/index.ts'
import { ConfigError } from '../src/errors.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
})
afterEach(() => test.cleanup())

const insertDaily = (o: {
  localDate: string
  metric?: string
  agg?: string
  source?: string
  value: number
  coverage?: number | null
  updatedAtMs: number | null
}) =>
  test.db.insert(daily).values({
    personId: 'p1', localDate: o.localDate, metric: o.metric ?? 'steps', agg: o.agg ?? 'sum',
    source: o.source ?? 'merged', value: o.value, coverage: o.coverage === undefined ? null : o.coverage,
    sourceMix: null, derivationVersion: 4, updatedAtMs: o.updatedAtMs,
  }).run()

describe('readChanges', () => {
  it('reports a pair whose row moved after since, and excludes one that did not', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, updatedAtMs: 1_000 })
    insertDaily({ localDate: '2026-08-02', value: 950, updatedAtMs: 5_000 })

    const { items } = readChanges(test.db, { personId: 'p1', since: 2_000 })
    expect(items).toEqual([{ localDate: '2026-08-02', metric: 'steps' }])
  })

  it('answers nothing for a since after the newest change', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, updatedAtMs: 1_000 })
    expect(readChanges(test.db, { personId: 'p1', since: 9_999 }).items).toEqual([])
  })

  // A day whose steps moved has a row per aggregate and per source: mean, sum, merged, and
  // whichever device reported it. A client asking what changed wants the day and metric once.
  it('collapses several rows for the same day and metric into one pair', () => {
    insertDaily({ localDate: '2026-08-01', metric: 'steps', source: 'merged', value: 900, updatedAtMs: 2_000 })
    insertDaily({ localDate: '2026-08-01', metric: 'steps', source: 'watch', value: 900, updatedAtMs: 3_000 })
    insertDaily({
      localDate: '2026-08-01', metric: 'steps', agg: 'mean', source: 'merged', value: 30, updatedAtMs: 1_500,
    })

    const { items } = readChanges(test.db, { personId: 'p1', since: 1_000 })
    expect(items).toEqual([{ localDate: '2026-08-01', metric: 'steps' }])
  })

  // A rebuild stamps a whole history with one clock reading, so every day legitimately reports
  // as changed. Length rather than a stamp comparison, since all three share the exact same one.
  it('reports every pair after a rebuild restamped them all with one clock reading', () => {
    for (let day = 1; day <= 3; day += 1) {
      insertDaily({ localDate: `2026-08-0${day}`, value: day * 100, updatedAtMs: 7_000 })
    }
    expect(readChanges(test.db, { personId: 'p1', since: 6_999 }).items).toHaveLength(3)
  })

  // Provider rows carry updated_at_ms too, stamped at the same insert sites as merged and per
  // source rows, even though a rollup figure has no samples underneath it.
  it('reports a provider row that moved', () => {
    insertDaily({
      localDate: '2026-08-01', metric: 'total_calories', source: 'provider',
      value: 2500, coverage: null, updatedAtMs: 5_000,
    })
    const { items } = readChanges(test.db, { personId: 'p1', since: 2_000 })
    expect(items).toEqual([{ localDate: '2026-08-01', metric: 'total_calories' }])
  })

  it('ignores a row with no updated_at_ms, which a rebuild has not reached', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, updatedAtMs: null })
    expect(readChanges(test.db, { personId: 'p1', since: 0 }).items).toEqual([])
  })

  // Total order: stamp first, then local date, then metric. Inserted in an order that would pass
  // under any weaker ordering, so only the stated order actually satisfies this.
  it('orders pairs by stamp, then local date, then metric', () => {
    insertDaily({ localDate: '2026-08-03', metric: 'floors', value: 1, updatedAtMs: 3_000 })
    insertDaily({ localDate: '2026-08-01', metric: 'weight', value: 1, updatedAtMs: 3_000 })
    insertDaily({ localDate: '2026-08-02', metric: 'steps', value: 1, updatedAtMs: 1_000 })

    const { items } = readChanges(test.db, { personId: 'p1', since: 0 })
    expect(items).toEqual([
      { localDate: '2026-08-02', metric: 'steps' },
      { localDate: '2026-08-01', metric: 'weight' },
      { localDate: '2026-08-03', metric: 'floors' },
    ])
  })

  it('caps a page at limit and hands back a cursor when more remain', () => {
    insertDaily({ localDate: '2026-08-01', metric: 'steps', value: 1, updatedAtMs: 1_000 })
    insertDaily({ localDate: '2026-08-02', metric: 'steps', value: 1, updatedAtMs: 2_000 })
    insertDaily({ localDate: '2026-08-03', metric: 'steps', value: 1, updatedAtMs: 3_000 })

    const page = readChanges(test.db, { personId: 'p1', since: 0, limit: 2 })
    expect(page.items).toEqual([
      { localDate: '2026-08-01', metric: 'steps' },
      { localDate: '2026-08-02', metric: 'steps' },
    ])
    expect(page.cursor).not.toBeNull()

    const next = readChanges(test.db, { personId: 'p1', since: 0, limit: 2, cursor: page.cursor! })
    expect(next.items).toEqual([{ localDate: '2026-08-03', metric: 'steps' }])
    expect(next.cursor).toBeNull()
  })

  // A rebuild leaves many pairs sharing one stamp, so a real client polling after one pages
  // through a long run of ties. The cursor has to break the tie itself, by local date then
  // metric, not just skip past a distinct stamp.
  it('pages correctly across a same-stamp tie, keyed by local date then metric', () => {
    insertDaily({ localDate: '2026-08-01', metric: 'floors', value: 1, updatedAtMs: 7_000 })
    insertDaily({ localDate: '2026-08-01', metric: 'steps', value: 1, updatedAtMs: 7_000 })
    insertDaily({ localDate: '2026-08-02', metric: 'steps', value: 1, updatedAtMs: 7_000 })

    const first = readChanges(test.db, { personId: 'p1', since: 0, limit: 2 })
    expect(first.items).toEqual([
      { localDate: '2026-08-01', metric: 'floors' },
      { localDate: '2026-08-01', metric: 'steps' },
    ])
    expect(first.cursor).not.toBeNull()

    const second = readChanges(test.db, { personId: 'p1', since: 0, limit: 2, cursor: first.cursor! })
    expect(second.items).toEqual([{ localDate: '2026-08-02', metric: 'steps' }])
    expect(second.cursor).toBeNull()
  })

  it('refuses a cursor that does not match any row in range', () => {
    insertDaily({ localDate: '2026-08-01', metric: 'steps', value: 1, updatedAtMs: 1_000 })
    expect(() => readChanges(test.db, {
      personId: 'p1', since: 0, cursor: Buffer.from('{"stamp":9,"localDate":"x","metric":"y"}').toString('base64url'),
    })).toThrow(ConfigError)
  })

  it('refuses a cursor that is not valid base64url json', () => {
    expect(() => readChanges(test.db, { personId: 'p1', since: 0, cursor: 'not-a-cursor!!' }))
      .toThrow(ConfigError)
  })

  // Well formed JSON of the wrong shape, which the parse itself cannot catch. `null` is the one
  // that used to get through: it parses, it is not an object the checks below would reject, and
  // the first field read off it threw a TypeError that reached the caller as a 500. Each of these
  // has to be a ConfigError, on a route built to be polled by a client that does not control what
  // its own stored cursor looks like after a version change.
  it.each([
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['a bare number', '7'],
    ['a string', '"cursor"'],
    ['an object missing a field', '{"stamp":9,"localDate":"2026-08-01"}'],
    ['an object whose stamp is not a number', '{"stamp":"9","localDate":"2026-08-01","metric":"steps"}'],
    ['an object whose stamp is not finite', '{"stamp":null,"localDate":"2026-08-01","metric":"steps"}'],
  ])('refuses a cursor that decodes to %s', (_name, json) => {
    expect(() => readChanges(test.db, {
      personId: 'p1', since: 0, cursor: Buffer.from(json, 'utf8').toString('base64url'),
    })).toThrow(ConfigError)
  })
})
