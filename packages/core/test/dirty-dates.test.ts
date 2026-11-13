import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, schema, SampleKeys, sampleDirtyDates } from '../src/index.ts'
import type { TestDatabase } from '../src/index.ts'
import type { SampleRow } from '../src/api/mapSamples.ts'

const START = Date.UTC(2026, 7, 1, 9, 0)
const END = START + 3_600_000

let test: TestDatabase

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  test.db.insert(schema.sources).values({
    id: 'alice-watch', personId: 'alice', externalId: 'alice-watch',
    displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  test.db.insert(schema.sessions).values({
    id: 'run', personId: 'alice', sourceId: 'alice-watch', kind: 'exercise', externalId: 'run',
    startMs: START, startOffsetMinutes: 0, endMs: END, endOffsetMinutes: 0,
    localDate: '2026-08-02', attrs: '{}', rawPayloadId: null,
  }).run()
})

afterEach(() => test.cleanup())

function heartRate(utcMs: number): SampleRow {
  return {
    personId: 'alice', sourceId: 'alice-watch', metric: 'heart_rate', utcMs, tzOffsetMinutes: 0,
    agg: 'mean', value: 60, n: 1, rawPayloadId: 'raw',
  }
}

describe('sampleDirtyDates and exercise spans', () => {
  it('marks a session that holds a reading', () => {
    const dates = sampleDirtyDates(test.db, [heartRate(START + 60_000)], new SampleKeys(test.db))
    expect(dates.has('2026-08-02')).toBe(true)
  })

  it('does not mark a session whose end is the only reading it touches, though the SQL prefilter admits it', () => {
    // One reading exactly at endMs and one before the start: [min, max] overlaps the session, but
    // the span is half-open, so no single instant is inside it.
    const rows = [heartRate(START - 60_000), heartRate(END)]
    const dates = sampleDirtyDates(test.db, rows, new SampleKeys(test.db))
    // The session is filed on 08-02, a date the readings themselves never reach.
    expect(dates.has('2026-08-02')).toBe(false)
  })
})
