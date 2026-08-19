import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { samples, daily, sessions, syncState } from '../src/db/schema/index.ts'

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name).sort()

describe('tier 2 and 3 schema', () => {
  it('gives samples an aggregate dimension, so a downsampled minute keeps min, mean and max', () => {
    expect(columnNames(samples)).toContain('agg')
    expect(columnNames(samples)).toContain('n')
  })

  it('keeps every sample attributed to its source, because merging never happens on write', () => {
    const sampleSource = getTableConfig(samples).columns.find((c) => c.name === 'source_id')
    const sessionSource = getTableConfig(sessions).columns.find((c) => c.name === 'source_id')
    expect(sampleSource?.notNull).toBe(true)
    expect(sessionSource?.notNull).toBe(true)
  })

  it('allows a null value, because missing is not zero', () => {
    const value = getTableConfig(samples).columns.find((c) => c.name === 'value')
    expect(value?.notNull).toBe(false)
  })

  it('carries coverage and a derivation version on every rollup', () => {
    const coverage = getTableConfig(daily).columns.find((c) => c.name === 'coverage')
    const derivationVersion = getTableConfig(daily).columns.find((c) => c.name === 'derivation_version')
    expect(coverage?.notNull).toBe(true)
    expect(derivationVersion?.notNull).toBe(true)
  })

  it('tracks a high-water mark per person and data type', () => {
    const cols = columnNames(syncState)
    expect(cols).toContain('person_id')
    expect(cols).toContain('data_type')
    expect(cols).toContain('high_water_ms')
  })
})
