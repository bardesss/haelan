import { describe, expect, it } from 'vitest'
import { people, credentials, rawPayloads, events, overrides } from '../src/db/schema/index.ts'
import { getTableConfig } from 'drizzle-orm/sqlite-core'

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name).sort()

describe('tier 1 schema', () => {
  it('keys every person-owned table by person, so no query can omit the filter by accident', () => {
    for (const table of [credentials, events, overrides]) {
      expect(columnNames(table)).toContain('person_id')
    }
  })

  it('stores instants as integers with the offset beside them', () => {
    const cols = getTableConfig(events).columns
    const startedAt = cols.find((c) => c.name === 'started_at_ms')
    const offset = cols.find((c) => c.name === 'started_at_offset_minutes')
    expect(startedAt?.getSQLType()).toBe('integer')
    expect(offset?.getSQLType()).toBe('integer')
  })

  it('deduplicates raw payloads by body hash', () => {
    const { uniqueConstraints, indexes } = getTableConfig(rawPayloads)
    const named = [...uniqueConstraints.map((u) => u.name), ...indexes.map((i) => i.config.name)]
    expect(named.join(' ')).toContain('body_hash')
  })

  it('gives people a timezone, because day boundaries are local', () => {
    expect(columnNames(people)).toContain('timezone')
  })
})
