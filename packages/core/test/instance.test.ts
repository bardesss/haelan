import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openHaelan } from '../src/instance.ts'
import { KEY_FILENAME, DATABASE_FILENAME } from '../src/index.ts'
import { people, rawPayloads } from '../src/db/schema/index.ts'

describe('openHaelan', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'haelan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates the database, runs migrations and generates the key in one call', () => {
    const instance = openHaelan(dir)
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true)
    expect(existsSync(join(dir, KEY_FILENAME))).toBe(true)
    expect(instance.db.select().from(people).all()).toEqual([])
    instance.close()
  })

  it('hands back stores already wired to the same key and database', () => {
    const instance = openHaelan(dir)
    instance.db.insert(people).values({ id: 'p1', displayName: 'p1', timezone: 'UTC', createdAtMs: 0 }).run()
    instance.credentials.putClient({ clientId: 'cid', clientSecret: 'shh', nowMs: 1 })
    expect(instance.credentials.getClient()).toEqual({ clientId: 'cid', clientSecret: 'shh' })
    instance.close()
  })

  it('reopens the same directory and reads what the previous instance wrote', () => {
    const first = openHaelan(dir)
    first.db.insert(people).values({ id: 'p1', displayName: 'p1', timezone: 'UTC', createdAtMs: 0 }).run()
    first.credentials.putRefreshToken({ personId: 'p1', refreshToken: 'rt', scopes: ['a'], nowMs: 1 })
    first.close()

    const second = openHaelan(dir)
    expect(second.credentials.getRefreshToken('p1')?.refreshToken).toBe('rt')
    second.close()
  })

  it('lets a store run inside a transaction, so a multi table write is one step', () => {
    const instance = openHaelan(dir)
    instance.db.insert(people).values({ id: 'p1', displayName: 'p1', timezone: 'UTC', createdAtMs: 0 }).run()

    expect(() => instance.db.transaction((tx) => {
      const archive = new (instance.archive.constructor as new (db: unknown) => typeof instance.archive)(tx)
      archive.put({
        personId: 'p1', dataType: 'steps', requestParams: {}, windowStartMs: 0, windowEndMs: 1,
        fetchedAtMs: 1, httpStatus: 200, body: '{"dataPoints":[]}',
      })
      throw new Error('roll back')
    })).toThrow(/roll back/)

    expect(instance.db.select().from(rawPayloads).all()).toHaveLength(0)
    instance.close()
  })
})
