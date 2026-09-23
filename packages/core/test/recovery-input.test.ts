import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readRecoveryInput } from '../src/query/recoveryInput.ts'
import { recoveryWindowStart } from '../src/api/recoveryIndex.ts'

let test: TestDatabase
beforeEach(() => { test = createTestDatabase(); seedPerson(test.db, 'p1') })
afterEach(() => test.cleanup())

const insert = (metric: string, agg: string, localDate: string, value: number) => test.db.insert(daily).values({
  personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
  derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
}).run()

describe('readRecoveryInput', () => {
  it('reads each of the five inputs from its declared metric and agg, from the window start', () => {
    const from = recoveryWindowStart('2026-08-20')
    insert('daily_hrv', 'last', from, 40)
    insert('resting_heart_rate', 'last', '2026-08-20', 55)
    insert('respiratory_rate', 'last', '2026-08-20', 14)
    insert('sleep_asleep_minutes', 'sum', '2026-08-20', 420)
    insert('sleep_bedtime_minutes', 'last', '2026-08-20', -30)
    const { input, hrvFilled } = readRecoveryInput(new PersonQuery(test.db, 'p1'), { from: '2026-08-20', to: '2026-08-20' })
    expect(input.hrv).toEqual([{ localDate: from, value: 40 }])
    expect(input.restingHeartRate).toEqual([{ localDate: '2026-08-20', value: 55 }])
    expect(input.respiratoryRate).toEqual([{ localDate: '2026-08-20', value: 14 }])
    expect(input.asleepMinutes).toEqual([{ localDate: '2026-08-20', value: 420 }])
    expect(input.bedtimeMinutes).toEqual([{ localDate: '2026-08-20', value: -30 }])
    expect(hrvFilled).toEqual({ filled: 0, of: 1 })
  })
})
