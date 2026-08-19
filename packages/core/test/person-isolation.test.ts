import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { CredentialStore } from '../src/store/credentials.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { rawPayloads } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const KEY = Buffer.alloc(32, 1)

describe('person isolation', () => {
  let ctx: TestDatabase

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'alice')
    seedPerson(ctx.db, 'bob')
  })
  afterEach(() => ctx.cleanup())

  it('never returns one person credentials under another person id', () => {
    const store = new CredentialStore(ctx.db, KEY)
    store.putRefreshToken({ personId: 'alice', refreshToken: 'alice-token', scopes: [], nowMs: 1 })
    expect(store.getRefreshToken('bob')).toBeNull()
    expect(store.getRefreshToken('alice')?.refreshToken).toBe('alice-token')
  })

  it('scopes raw payloads to their owner', () => {
    const archive = new RawArchive(ctx.db)
    archive.put({
      personId: 'alice', dataType: 'steps', requestParams: {}, windowStartMs: 0,
      windowEndMs: 1, fetchedAtMs: 1, httpStatus: 200, body: '{"dataPoints":[]}',
    })
    const bobRows = ctx.db.select().from(rawPayloads).where(eq(rawPayloads.personId, 'bob')).all()
    expect(bobRows).toHaveLength(0)
  })

  it('refuses a row for a person who does not exist, so a typo cannot orphan data', () => {
    const archive = new RawArchive(ctx.db)
    expect(() => archive.put({
      personId: 'nobody', dataType: 'steps', requestParams: {}, windowStartMs: 0,
      windowEndMs: 1, fetchedAtMs: 1, httpStatus: 200, body: '{}',
    })).toThrow()
  })
})
