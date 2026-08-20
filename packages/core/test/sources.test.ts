import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { sources } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const fitbitWatch = {
  platform: 'FITBIT',
  recordingMethod: 'PASSIVELY_MEASURED',
  device: { displayName: 'Sense 2', formFactor: 'WATCH' },
}
const healthConnect = { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED' }

describe('SourceRegistry', () => {
  let ctx: TestDatabase
  let registry: SourceRegistry

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    registry = new SourceRegistry(ctx.db)
  })
  afterEach(() => ctx.cleanup())

  it('creates a row the first time it sees a source', () => {
    const id = registry.resolve('p1', fitbitWatch, 1000)
    const rows = ctx.db.select().from(sources).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, personId: 'p1', displayName: 'Sense 2', kind: 'device' })
  })

  it('returns the same id for the same source rather than accumulating rows', () => {
    const first = registry.resolve('p1', fitbitWatch, 1000)
    const second = registry.resolve('p1', fitbitWatch, 2000)
    expect(second).toBe(first)
    expect(ctx.db.select().from(sources).all()).toHaveLength(1)
  })

  it('distinguishes two platforms, because a payload can carry both', () => {
    const a = registry.resolve('p1', fitbitWatch, 1000)
    const b = registry.resolve('p1', healthConnect, 1000)
    expect(b).not.toBe(a)
    expect(ctx.db.select().from(sources).all()).toHaveLength(2)
  })

  it('calls a source with no device an app rather than inventing a device name', () => {
    registry.resolve('p1', healthConnect, 1000)
    const row = ctx.db.select().from(sources).all()[0]
    expect(row?.kind).toBe('app')
    expect(row?.displayName).toBe('HEALTH_CONNECT')
  })

  it('keeps one person sources separate from another', () => {
    seedPerson(ctx.db, 'p2')
    const a = registry.resolve('p1', fitbitWatch, 1000)
    const b = registry.resolve('p2', fitbitWatch, 1000)
    expect(b).not.toBe(a)
  })

  it('resolves an absent or unreadable dataSource to a named unknown rather than throwing', () => {
    const id = registry.resolve('p1', undefined, 1000)
    expect(id).toBeTruthy()
    expect(ctx.db.select().from(sources).all()[0]?.displayName).toBe('unknown')
  })

  it('caches within an instance, so a thousand points do not become a thousand selects', () => {
    const id = registry.resolve('p1', fitbitWatch, 1000)
    ctx.db.delete(sources).run()
    expect(registry.resolve('p1', fitbitWatch, 1000)).toBe(id)
  })
})
