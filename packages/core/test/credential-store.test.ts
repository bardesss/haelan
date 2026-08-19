import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { openDatabase, closeDatabase } from '../src/db/open.ts'
import { migrateToLatest } from '../src/db/migrate.ts'
import { people } from '../src/db/schema/index.ts'
import { CredentialStore } from '../src/store/credentials.ts'
import type { Database } from '../src/db/open.ts'

const KEY = Buffer.alloc(32, 9)

describe('CredentialStore', () => {
  let dir: string
  let db: Database
  let store: CredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-'))
    db = openDatabase(dir)
    migrateToLatest(db)
    db.insert(people).values({
      id: 'p1', displayName: 'Test', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    store = new CredentialStore(db, KEY)
  })
  afterEach(() => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) })

  it('round-trips the client secret', () => {
    store.putClient({ clientId: 'cid', clientSecret: 'shh', nowMs: 1 })
    expect(store.getClient()).toEqual({ clientId: 'cid', clientSecret: 'shh' })
  })

  it('never stores the secret in the clear', () => {
    store.putClient({ clientId: 'cid', clientSecret: 'shh', nowMs: 1 })
    const rows = db.all<{ client_secret_encrypted: string }>(sql`select client_secret_encrypted from oauth_client`)
    expect(rows[0]?.client_secret_encrypted).not.toContain('shh')
  })

  it('replaces the client rather than accumulating rows, because there is one per household', () => {
    store.putClient({ clientId: 'a', clientSecret: 'one', nowMs: 1 })
    store.putClient({ clientId: 'b', clientSecret: 'two', nowMs: 2 })
    expect(store.getClient()).toEqual({ clientId: 'b', clientSecret: 'two' })
    expect(db.all(sql`select 1 from oauth_client`)).toHaveLength(1)
  })

  it('returns null when nothing is configured yet, which is how the wizard knows to run', () => {
    expect(store.getClient()).toBeNull()
    expect(store.getRefreshToken('p1')).toBeNull()
  })

  it('round-trips a refresh token per person', () => {
    store.putRefreshToken({ personId: 'p1', refreshToken: 'rt', scopes: ['a', 'b'], nowMs: 5 })
    expect(store.getRefreshToken('p1')).toEqual({ refreshToken: 'rt', scopes: ['a', 'b'], revokedAtMs: null })
  })

  it('never stores the refresh token in the clear', () => {
    store.putRefreshToken({ personId: 'p1', refreshToken: 'rt-secret', scopes: [], nowMs: 5 })
    const rows = db.all<{ refresh_token_encrypted: string }>(sql`select refresh_token_encrypted from credentials`)
    expect(rows[0]?.refresh_token_encrypted).not.toContain('rt-secret')
  })

  it('marks revoked without destroying the token, so a reconnect banner has something to explain', () => {
    store.putRefreshToken({ personId: 'p1', refreshToken: 'rt', scopes: [], nowMs: 5 })
    store.markRevoked('p1', 100)
    expect(store.getRefreshToken('p1')?.revokedAtMs).toBe(100)
    store.clearRevoked('p1')
    expect(store.getRefreshToken('p1')?.revokedAtMs).toBeNull()
  })

  it('lists only people whose credentials are not revoked, because sync pauses per person', () => {
    db.insert(people).values({
      id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    store.putRefreshToken({ personId: 'p1', refreshToken: 'a', scopes: [], nowMs: 1 })
    store.putRefreshToken({ personId: 'p2', refreshToken: 'b', scopes: [], nowMs: 1 })
    store.markRevoked('p2', 50)
    expect(store.listConnectedPeople()).toEqual(['p1'])
  })
})
