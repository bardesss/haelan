import { describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { seedArchive } from '../src/testing/seed.ts'
import { rawPayloads, samples, daily, sessions } from '../src/db/schema/index.ts'

const END = Date.parse('2026-03-01T00:00:00Z')

describe('seedArchive', () => {
  it('writes archive payloads and not one derived row', () => {
    const test = createTestDatabase()
    try {
      seedPerson(test.db, 'p1')
      seedArchive({ archive: new RawArchive(test.db), personId: 'p1', days: 7, endMs: END })

      expect(test.db.select().from(rawPayloads).all().length).toBeGreaterThan(0)
      // The whole premise: everything a chart shows is derived by the app from these bodies. A
      // seed that wrote a derived row could draw a chart no real instance could ever produce.
      expect(test.db.select().from(samples).all()).toEqual([])
      expect(test.db.select().from(daily).all()).toEqual([])
      expect(test.db.select().from(sessions).all()).toEqual([])
    } finally { test.cleanup() }
  })

  it('gives the same bytes for the same seed, and different ones for a different seed', () => {
    const bodies = (seed: number): string[] => {
      const test = createTestDatabase()
      try {
        seedPerson(test.db, 'p1')
        const archive = new RawArchive(test.db)
        seedArchive({ archive, personId: 'p1', days: 5, endMs: END, seed })
        return test.db.select().from(rawPayloads).all()
          .map((r) => r.bodyHash).sort()
      } finally { test.cleanup() }
    }
    expect(bodies(1)).toEqual(bodies(1))
    expect(bodies(1)).not.toEqual(bodies(2))
  })

  it('covers every derived table once the app rebuilds from it', () => {
    // Named here rather than in the rehearsal because it is the generator's promise, not the
    // migration's: a seed that produced no sleep would let the rehearsal pass while proving
    // nothing about sessions.
    const test = createTestDatabase()
    try {
      seedPerson(test.db, 'p1')
      seedArchive({ archive: new RawArchive(test.db), personId: 'p1', days: 14, endMs: END })
      const types = new Set(test.db.select().from(rawPayloads).all().map((r) => r.dataType))
      for (const id of ['steps', 'heart-rate', 'weight', 'sleep', 'exercise']) {
        expect(types.has(id), id).toBe(true)
      }
    } finally { test.cleanup() }
  })
})
