import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, people, sessions, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readBodyAge, readBodyAgeInput } from '../src/query/bodyAgeRead.ts'
import { datesIn } from '../src/query/periodBounds.ts'
import { BODY_AGE_FACTORS, bodyAgeHistory } from '../src/api/bodyAge.ts'

// Synthetic days only: sixty days of every input, rows as the derive step stores them.
const TODAY = '2026-09-23'
const FIRST = shiftLocalDate(TODAY, -59)
const OFFSET = 120

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.update(people).set({ birthDate: '1990-06-15', sex: 'male' }).where(eq(people.id, 'p1')).run()
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => {
  vi.restoreAllMocks()
  test.cleanup()
})

const q = () => new PersonQuery(test.db, 'p1')

function seed(metric: string, agg: 'last' | 'sum', value: (date: string, i: number) => number | null, o: { coverage?: number | null } = {}) {
  const rows = datesIn({ from: FIRST, to: TODAY }).flatMap((localDate, i) => {
    const v = value(localDate, i)
    return v === null ? [] : [{
      personId: 'p1', localDate, metric, agg, source: 'merged', value: v, coverage: o.coverage === undefined ? 1 : o.coverage,
      sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }]
  })
  test.db.insert(daily).values(rows).run()
}

function seedWorkout(localDate: string, exerciseType: string) {
  const id = `${exerciseType}-${localDate}`
  const startMs = Date.parse(`${localDate}T07:00:00Z`) - OFFSET * 60_000
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs: startMs + 40 * 60_000, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({ exerciseType, activeDuration: '1800s', metricsSummary: null }),
  }).run()
}

function seedEverything(vo2Metric = 'daily_vo2_max') {
  seed(vo2Metric, 'last', () => 45)
  seed('resting_heart_rate', 'last', (_, i) => 58 + (i % 3))
  seed('daily_hrv', 'last', (_, i) => 45 + (i % 4))
  seed('sleep_bedtime_minutes', 'last', (_, i) => -30 + (i % 5) * 10)
  seed('active_minutes_moderate', 'sum', () => 20)
  seed('active_minutes_vigorous', 'sum', () => 5)
}

describe('readBodyAge', () => {
  it('equals bodyAgeHistory over the same arrays built by hand', () => {
    seedEverything()
    const dates = datesIn({ from: FIRST, to: TODAY })
    seedWorkout(dates[10]!, 'STRENGTH_TRAINING')
    const byHand = bodyAgeHistory({
      birthDate: '1990-06-15',
      sex: 'male',
      vo2Max: dates.map((localDate) => ({ localDate, value: 45 })),
      restingHeartRate: dates.map((localDate, i) => ({ localDate, value: 58 + (i % 3) })),
      hrv: dates.map((localDate, i) => ({ localDate, value: 45 + (i % 4) })),
      activityMinutes: dates.map((localDate) => ({ localDate, value: 20 + 2 * 5 })),
      bedtimeMinutes: dates.map((localDate, i) => ({ localDate, value: -30 + (i % 5) * 10 })),
      strengthSessionDates: [dates[10]!],
    }, TODAY)

    const read = readBodyAge(test.db, 'p1', { today: TODAY })
    const { method, ...history } = read
    expect(method).toBeDefined()
    expect(history).toEqual(byHand)
    expect(read.current?.enough).toBe(true)
  })

  it('starts the span at the earliest daily row and counts vigorous minutes double', () => {
    seedEverything()
    const { input, from } = readBodyAgeInput(test.db, 'p1', { today: TODAY })
    expect(from).toBe(FIRST)
    expect(input.activityMinutes[0]).toEqual({ localDate: FIRST, value: 30 })
    expect(input.activityMinutes).toHaveLength(60)
  })

  it('counts a day with only one of the two activity levels', () => {
    seed('active_minutes_vigorous', 'sum', (d) => (d === TODAY ? 4 : null))
    const { input } = readBodyAgeInput(test.db, 'p1', { today: TODAY })
    expect(input.activityMinutes).toEqual([{ localDate: TODAY, value: 8 }])
  })

  it('falls back to run_vo2_max when the other two VO2 metrics have no rows', () => {
    seedEverything('run_vo2_max')
    const { input } = readBodyAgeInput(test.db, 'p1', { today: TODAY })
    expect(input.vo2Max).toHaveLength(60)
    expect(readBodyAge(test.db, 'p1', { today: TODAY }).current?.enough).toBe(true)
  })

  it('prefers daily_vo2_max over the others', () => {
    seed('run_vo2_max', 'last', () => 30)
    seed('daily_vo2_max', 'last', () => 50)
    const { input } = readBodyAgeInput(test.db, 'p1', { today: TODAY })
    expect(input.vo2Max.every((d) => d.value === 50)).toBe(true)
  })

  it('does not count a session that is not strength training', () => {
    seedEverything()
    seedWorkout(shiftLocalDate(TODAY, -5), 'RUNNING')
    seedWorkout(shiftLocalDate(TODAY, -3), 'WEIGHTLIFTING')
    const { input } = readBodyAgeInput(test.db, 'p1', { today: TODAY })
    expect(input.strengthSessionDates).toEqual([shiftLocalDate(TODAY, -3)])
  })

  it('withholds the body age of a person with no birth date', () => {
    seedEverything()
    test.db.update(people).set({ birthDate: null }).where(eq(people.id, 'p1')).run()
    const read = readBodyAge(test.db, 'p1', { today: TODAY })
    expect(read.current?.enough).toBe(false)
    expect(read.current?.enough === false && read.current.missing).toContain('birthDate')
  })

  it('reads sleep regularity from rows whose coverage is null', () => {
    seedEverything()
    test.db.delete(daily).where(eq(daily.metric, 'sleep_bedtime_minutes')).run()
    seed('sleep_bedtime_minutes', 'last', (_, i) => -30 + (i % 5) * 10, { coverage: null })
    const current = readBodyAge(test.db, 'p1', { today: TODAY }).current
    expect(current?.enough).toBe(true)
    const factor = current?.enough ? current.factors.find((f) => f.key === 'sleepRegularity') : undefined
    expect(factor?.missing).toBeNull()
    expect(factor?.days).toBeGreaterThan(0)
  })

  it('answers an empty history for a person with no daily rows, from today', () => {
    const { from, input } = readBodyAgeInput(test.db, 'p1', { today: TODAY })
    expect(from).toBe(TODAY)
    expect(input.vo2Max).toEqual([])
    const read = readBodyAge(test.db, 'p1', { today: TODAY })
    expect(read.current).toBeNull()
    expect(read.months).toEqual([])
  })

  it('never passes points to series', () => {
    seedEverything()
    const spy = vi.spyOn(PersonQuery.prototype, 'series')
    readBodyAge(test.db, 'p1', { today: TODAY })
    expect(spy).toHaveBeenCalled()
    for (const [args] of spy.mock.calls) expect(args).not.toHaveProperty('points')
  })

  it('lists every factor with its cap and citation as the method', () => {
    const { method } = readBodyAge(test.db, 'p1', { today: TODAY })
    expect(method.factors).toEqual(BODY_AGE_FACTORS.map(({ key, unit, cap, citation }) => ({ key, unit, cap, citation })))
  })

  it('is reachable through PersonQuery, and rejects a bad date', () => {
    seedEverything()
    expect(q().bodyAge({ today: TODAY })).toEqual(readBodyAge(test.db, 'p1', { today: TODAY }))
    expect(() => q().bodyAge({ today: 'nope' })).toThrow()
  })
})
