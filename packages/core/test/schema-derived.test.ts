import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { eq } from 'drizzle-orm'
import { samples, daily, sessions, sessionRoutes, syncState, deriveQueue } from '../src/db/schema/index.ts'
import { createTestDatabase, seedPerson, seedSession } from '../src/testing/fixtures.ts'

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name).sort()

describe('tier 2 and 3 schema', () => {
  it('gives samples an aggregate dimension, so a downsampled minute keeps min, mean and max', () => {
    expect(columnNames(samples)).toContain('agg_ref')
    expect(columnNames(samples)).toContain('n')
  })

  it('keeps every sample attributed to its source, because merging never happens on write', () => {
    const sampleSource = getTableConfig(samples).columns.find((c) => c.name === 'source_ref')
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

  it('carries a nullable updated_at_ms, because a row derived before M3b has no honest stamp', () => {
    const updatedAtMs = getTableConfig(daily).columns.find((c) => c.name === 'updated_at_ms')
    expect(updatedAtMs?.notNull).toBe(false)
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

  // A route is tier 2, like the session it belongs to. A rebuild deletes and regenerates a
  // session, and a route row left behind would attach to nothing and be drawn for nobody.
  it('deletes a route with its session', () => {
    const { db, cleanup } = createTestDatabase()
    try {
      seedPerson(db, 'p1')
      seedSession(db, { id: 'session-1', personId: 'p1', kind: 'exercise', externalId: 'ext-1' })
      db.insert(sessionRoutes).values([
        { id: 'r1', sessionId: 'session-1', ordinal: 0, atMs: 0, latitude: 52.1, longitude: 5.1 },
        { id: 'r2', sessionId: 'session-1', ordinal: 1, atMs: 1000, latitude: 52.2, longitude: 5.2 },
      ]).run()

      db.delete(sessions).where(eq(sessions.id, 'session-1')).run()

      const remaining = db.select().from(sessionRoutes).where(eq(sessionRoutes.sessionId, 'session-1')).all()
      expect(remaining.length).toBe(0)
    } finally { cleanup() }
  })
})
