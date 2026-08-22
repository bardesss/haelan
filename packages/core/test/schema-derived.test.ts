import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { samples, daily, sessions, syncState, deriveQueue } from '../src/db/schema/index.ts'

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

  it('allows a null coverage, because a provider rollup has no samples to measure', () => {
    const coverage = getTableConfig(daily).columns.find((c) => c.name === 'coverage')
    const derivationVersion = getTableConfig(daily).columns.find((c) => c.name === 'derivation_version')
    // Null means no basis to measure, not zero. A provider reconciled row carries no samples
    // underneath it, and 1.0 would read to M2d's insight suppression as a fully observed day.
    expect(coverage?.notNull).toBe(false)
    expect(derivationVersion?.notNull).toBe(true)
  })

  it('carries a nullable source mix, because only a merged row has one', () => {
    const mix = getTableConfig(daily).columns.find((c) => c.name === 'source_mix')
    // Null on a per source row, which has nothing to mix, and on a provider row, whose mix
    // Google performed and did not show us. An empty array for either would be a claim.
    expect(mix?.notNull).toBe(false)
  })

  it('queues a person and a local date, so one dirty day is one row however many metrics it touches', () => {
    const cols = columnNames(deriveQueue)
    expect(cols).toEqual(['local_date', 'person_id', 'queued_at_ms'])
  })

  it('tracks a high-water mark per person and data type', () => {
    const cols = columnNames(syncState)
    expect(cols).toContain('person_id')
    expect(cols).toContain('data_type')
    expect(cols).toContain('high_water_ms')
  })
})
