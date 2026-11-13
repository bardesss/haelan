import { describe, it, expect } from 'vitest'
import { createTestDatabase } from '../src/testing/fixtures.ts'

describe('companion record links and tombstones', () => {
  it('the latest migration creates the record link and tombstone tables', () => {
    const ctx = createTestDatabase()
    const names = ctx.db.$client.prepare("select name from sqlite_master where type = 'table'").all()
      .map((r) => (r as { name: string }).name)
    expect(names).toEqual(expect.arrayContaining(['companion_record_samples', 'companion_deletions']))
    ctx.cleanup()
  })
})
