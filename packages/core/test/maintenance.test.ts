import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import { databaseBloat, freeDiskBytes } from '../src/db/maintenance.ts'

describe('databaseBloat', () => {
  it('reports a fresh database as almost entirely live', () => {
    const test = createTestDatabase()
    try {
      const bloat = databaseBloat(test.db)
      expect(bloat.fileBytes).toBeGreaterThan(0)
      expect(bloat.liveBytes + bloat.freeBytes).toBe(bloat.fileBytes)
      expect(bloat.freeFraction).toBeLessThan(0.2)
    } finally { test.cleanup() }
  })

  it('counts pages freed by a delete as free rather than gone', () => {
    const test = createTestDatabase()
    try {
      // Enough rows that deleting them frees whole pages rather than leaving them part used.
      for (let i = 0; i < 4000; i += 1) {
        test.db.run(sql`insert into metrics (name) values (${`metric_${i}`})`)
      }
      const full = databaseBloat(test.db)
      test.db.run(sql`delete from metrics`)
      const emptied = databaseBloat(test.db)

      // The file does not shrink - that is the whole premise of this unit - so the freed space
      // has to show up as free pages inside a file that is still the same size.
      expect(emptied.fileBytes).toBe(full.fileBytes)
      expect(emptied.freeBytes).toBeGreaterThan(full.freeBytes)
      expect(emptied.liveBytes).toBeLessThan(full.liveBytes)
    } finally { test.cleanup() }
  })
})

describe('freeDiskBytes', () => {
  it('answers a positive number of bytes for a directory that exists', () => {
    expect(freeDiskBytes(process.cwd())).toBeGreaterThan(0)
  })
})
