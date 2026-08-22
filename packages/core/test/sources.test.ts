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

  // Two apps behind Health Connect with no device between them collapsed onto the bare platform,
  // so a scale app and a manual weight entry landed on one source id. Spec section 9's merge
  // policy is meant to let a person choose between sources and filter their own manual entries
  // out; it cannot do either against a source that is both.
  const scaleApp = {
    platform: 'HEALTH_CONNECT', recordingMethod: 'PASSIVELY_MEASURED',
    application: { packageName: 'com.withings.wiscale2' },
  }
  const typedByHand = {
    platform: 'HEALTH_CONNECT', recordingMethod: 'MANUAL',
    application: { packageName: 'com.google.android.apps.fitness' },
  }

  it('separates two apps behind one platform, because the package name is what tells them apart', () => {
    const a = registry.resolve('p1', scaleApp, 1000)
    const b = registry.resolve('p1', { ...scaleApp, application: { packageName: 'com.fitbit.FitbitMobile' } }, 1000)
    expect(b).not.toBe(a)
    const rows = ctx.db.select().from(sources).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.displayName).sort())
      .toEqual(['com.fitbit.FitbitMobile', 'com.withings.wiscale2'])
  })

  // The sources schema has carried a 'manual' kind since the first migration and nothing ever
  // produced one. A reading somebody typed in is not a measurement, and telling them apart is
  // the whole point of recording provenance at ingest.
  it('records a hand-typed reading as a manual source, separate from the same app measuring', () => {
    const measured = registry.resolve('p1', scaleApp, 1000)
    const entered = registry.resolve('p1', typedByHand, 1000)
    expect(entered).not.toBe(measured)
    const rows = ctx.db.select().from(sources).all()
    expect(rows.find((r) => r.id === entered)?.kind).toBe('manual')
    expect(rows.find((r) => r.id === measured)?.kind).toBe('app')
  })

  it('does not split a source over how a measurement was taken, only over who took it', () => {
    // DERIVED and PASSIVELY_MEASURED are both the app measuring; only MANUAL is a different
    // hand. Splitting on every recordingMethod would turn one app into three sources.
    const derived = registry.resolve('p1', { ...scaleApp, recordingMethod: 'DERIVED' }, 1000)
    const passive = registry.resolve('p1', { ...scaleApp, recordingMethod: 'PASSIVELY_MEASURED' }, 1000)
    expect(derived).toBe(passive)
  })

  // Widening the identity re-keys only what was genuinely ambiguous. A device source and a bare
  // platform source carry neither a package name nor a manual flag, so their ids are unchanged
  // and the rows already written against them stay attached. These two literals are what the
  // instance on disk holds; if they ever change, existing data has been orphaned.
  it('leaves an unambiguous source id exactly where it was', () => {
    expect(registry.resolve('p1', fitbitWatch, 1000)).toBe('9d2fbcacbdfff0a56cd633cb807790f6')
    expect(registry.resolve('p1', healthConnect, 1000)).toBe('4def39c8c91c3c5e706eb5d83f56c242')
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

  it('forgets one person cached ids and leaves another person cache alone', () => {
    seedPerson(ctx.db, 'p2')
    const a = registry.resolve('p1', fitbitWatch, 1000)
    const b = registry.resolve('p2', fitbitWatch, 1000)
    // Standing in for the rollback that takes both rows away while both cache entries survive.
    ctx.db.delete(sources).run()

    registry.forget('p1')

    // p1 was forgotten, so it goes back to the database, finds nothing and writes the row again.
    expect(registry.resolve('p1', fitbitWatch, 2000)).toBe(a)
    expect(ctx.db.select().from(sources).all()).toHaveLength(1)
    // p2 was not, so it answers from the cache without writing anything.
    expect(registry.resolve('p2', fitbitWatch, 2000)).toBe(b)
    expect(ctx.db.select().from(sources).all()).toHaveLength(1)
  })
})
