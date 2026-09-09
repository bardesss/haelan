import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson, seedSample } from '../src/testing/fixtures.ts'
import { SampleKeys } from '../src/db/keys.ts'
import { ConfigError } from '../src/errors.ts'
import { people, sources, metricDictionary } from '../src/db/schema/index.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { eq } from 'drizzle-orm'
import type { TestDatabase } from '../src/testing/fixtures.ts'

describe('SampleKeys', () => {
  let ctx: TestDatabase
  let keys: SampleKeys

  beforeEach(() => {
    ctx = createTestDatabase()
    keys = new SampleKeys(ctx.db)
  })
  afterEach(() => ctx.cleanup())

  describe('metricRef / metricName', () => {
    it('returns the same ref for the same name twice', () => {
      const first = keys.metricRef('heart_rate')
      const second = keys.metricRef('heart_rate')
      expect(second).toBe(first)
    })

    it('returns different refs for different names', () => {
      const heartRate = keys.metricRef('heart_rate')
      const steps = keys.metricRef('steps')
      expect(steps).not.toBe(heartRate)
    })

    it('inserts a row for an unseen name, so a catalogue addition needs no migration', () => {
      const ref = keys.metricRef('new_metric')
      const row = ctx.db.select({ name: metricDictionary.name }).from(metricDictionary)
        .where(eq(metricDictionary.ref, ref)).get()
      expect(row?.name).toBe('new_metric')
    })

    it('round-trips every ref metricRef returned', () => {
      const refs = ['heart_rate', 'steps', 'weight'].map((name) => ({ name, ref: keys.metricRef(name) }))
      for (const { name, ref } of refs) {
        expect(keys.metricName(ref)).toBe(name)
      }
    })

    it('throws ConfigError for a ref nothing assigned, rather than returning undefined', () => {
      expect(() => keys.metricName(999)).toThrow(ConfigError)
    })
  })

  describe('personRef / personId', () => {
    it('resolves an existing row', () => {
      seedPerson(ctx.db, 'p1')
      const ref = ctx.db.select({ ref: people.ref }).from(people).where(eq(people.id, 'p1')).get()
      expect(keys.personRef('p1')).toBe(ref?.ref)
      expect(keys.personId(ref!.ref)).toBe('p1')
    })

    it('throws for an id that does not exist', () => {
      expect(() => keys.personRef('nobody')).toThrow(ConfigError)
    })

    it('throws for a ref that does not exist', () => {
      expect(() => keys.personId(999)).toThrow(ConfigError)
    })
  })

  describe('sourceRef / sourceId', () => {
    it('resolves an existing row', () => {
      seedPerson(ctx.db, 'p1')
      seedSample(ctx.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: 0 })
      const ref = ctx.db.select({ ref: sources.ref }).from(sources).where(eq(sources.id, 'watch')).get()
      expect(keys.sourceRef('watch')).toBe(ref?.ref)
      expect(keys.sourceId(ref!.ref)).toBe('watch')
    })

    it('throws for an id that does not exist', () => {
      expect(() => keys.sourceRef('nowhere')).toThrow(ConfigError)
    })

    it('throws for a ref that does not exist', () => {
      expect(() => keys.sourceId(999)).toThrow(ConfigError)
    })
  })

  describe('rawPayloadRef / rawPayloadId', () => {
    it('resolves an existing row', () => {
      seedPerson(ctx.db, 'p1')
      const archive = new RawArchive(ctx.db)
      const { id } = archive.put({
        personId: 'p1', dataType: 'heart-rate', requestParams: { filter: 'x' },
        windowStartMs: 0, windowEndMs: 1000, fetchedAtMs: 1, httpStatus: 200, body: '{}',
      })
      const ref = keys.rawPayloadRef(id)
      expect(keys.rawPayloadId(ref)).toBe(id)
    })

    it('throws for an id that does not exist', () => {
      expect(() => keys.rawPayloadRef('nothing-archived')).toThrow(ConfigError)
    })

    it('throws for a ref that does not exist', () => {
      expect(() => keys.rawPayloadId(999)).toThrow(ConfigError)
    })
  })

  // Protects a rebuild: a person transaction that rolls back must not leave a SampleKeys whose
  // cache still answers for rows the rollback took away. The fix is in how the class is used, not
  // just how it is written - build a fresh instance per transaction rather than reusing one across
  // it - so this proves the usage pattern rather than reusing the instance that saw the rollback.
  it('does not let the cache survive a rolled-back transaction', () => {
    let assignedRef = -1
    expect(() => ctx.db.transaction((tx) => {
      const txKeys = new SampleKeys(tx)
      assignedRef = txKeys.metricRef('new_metric')
      throw new Error('roll back')
    })).toThrow(/roll back/)

    const fresh = new SampleKeys(ctx.db)
    expect(() => fresh.metricName(assignedRef)).toThrow(ConfigError)
  })
})
