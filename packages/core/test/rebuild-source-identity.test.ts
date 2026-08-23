import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { eq } from 'drizzle-orm'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { samples, sources } from '../src/db/schema/index.ts'
import { seedRebuildable } from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

let h: Rebuildable
afterEach(() => { h.cleanup() })

const idFor = (personId: string, externalId: string): string =>
  createHash('sha256').update(`${personId} ${externalId}`).digest('hex').slice(0, 32)

describe('rebuild re-derives source identity', () => {
  test('a source written before describe() widened does not survive the rebuild', () => {
    // An app reporting through Health Connect with no device between it and the platform. Before
    // describe() took the package name, every such app collapsed onto one source called after the
    // platform alone; a scale app and a food diary became one source nobody could choose between.
    h = seedRebuildable({
      dataSource: {
        platform: 'HEALTH_CONNECT',
        application: { packageName: 'com.example.scale' },
      },
    })
    const stale = idFor(h.personId, 'HEALTH_CONNECT')
    h.db.insert(sources).values({
      id: stale, personId: h.personId, externalId: 'HEALTH_CONNECT',
      displayName: 'HEALTH_CONNECT', kind: 'app', createdAtMs: 1,
    }).run()

    runRebuild({ ...h.deps, nowMs: 1, force: true })

    const rows = h.db.select().from(sources).where(eq(sources.personId, h.personId)).all()
    expect(rows.map((r) => r.externalId)).toEqual(['HEALTH_CONNECT:com.example.scale'])
    expect(rows[0]!.id).toBe(idFor(h.personId, 'HEALTH_CONNECT:com.example.scale'))
    // And nothing is left pointing at the identity that came off the disk.
    expect(h.db.select().from(samples).where(eq(samples.sourceId, stale)).all()).toEqual([])
  })
})

// Each fast-check run here creates a fresh sqlite file, migrates it, archives payloads and runs a
// full rebuild, unlike the pure-function properties elsewhere in this suite. Fifty of those comes
// in well under the default budget when this file runs alone, but under the full suite's
// parallelism (roughly one vitest fork per core, per the root config) the same fifty runs cost
// more than 20s. That is the same reasoning apps/server/test/sync-runner.test.ts names for
// SPRINT_BUDGET_MS: a genuinely hung test should still fail, but the default budget is sized for
// unit work, not fifty database rebuilds sharing a core with ninety other files.
const REBUILD_PROPERTY_BUDGET_MS = 60_000

describe('rebuild source identity, as a property', () => {
  const dataSourceArb = fc.record({
    platform: fc.constantFrom('FITBIT', 'HEALTH_CONNECT', 'GOOGLE_FIT'),
    device: fc.option(fc.record({ displayName: fc.constantFrom('Pixel Watch', 'Pixel 8') }), { nil: undefined }),
    application: fc.option(fc.record({ packageName: fc.constantFrom('com.a.app', 'com.b.app') }), { nil: undefined }),
    recordingMethod: fc.constantFrom('MANUAL', 'AUTOMATICALLY_RECORDED', 'DERIVED'),
  }, { requiredKeys: ['platform', 'recordingMethod'] })

  test('no identity from the disk survives, and every surviving one is derived', () => {
    fc.assert(fc.property(
      fc.array(dataSourceArb, { minLength: 1, maxLength: 4 }),
      // Identities that could only have come from an older mapping. The prefix guarantees they
      // cannot collide with anything describe() produces, which always begins with a platform.
      fc.array(fc.constantFrom('stale-a', 'stale-b', 'stale-c'), { maxLength: 3 }),
      (dataSources, staleIds) => {
        h = seedRebuildable({ dataSources })
        for (const externalId of new Set(staleIds)) {
          h.db.insert(sources).values({
            id: idFor(h.personId, externalId), personId: h.personId, externalId,
            displayName: externalId, kind: 'app', createdAtMs: 1,
          }).run()
        }

        runRebuild({ ...h.deps, nowMs: 1, force: true })

        const rows = h.db.select().from(sources).where(eq(sources.personId, h.personId)).all()
        // Nothing that came off the disk is still here.
        expect(rows.filter((r) => r.externalId.startsWith('stale-'))).toEqual([])
        // Every id is the hash of the identity beside it, rather than whatever was stored.
        for (const row of rows) expect(row.id).toBe(idFor(h.personId, row.externalId))
        // And no sample points at a source that is gone.
        const live = new Set(rows.map((r) => r.id))
        const orphans = h.db.select().from(samples)
          .where(eq(samples.personId, h.personId)).all()
          .filter((row) => !live.has(row.sourceId))
        expect(orphans).toEqual([])
      },
    ), { numRuns: 50 })
  }, REBUILD_PROPERTY_BUDGET_MS)

  test('a second rebuild changes nothing', () => {
    fc.assert(fc.property(
      fc.array(dataSourceArb, { minLength: 1, maxLength: 4 }),
      (dataSources) => {
        h = seedRebuildable({ dataSources })
        runRebuild({ ...h.deps, nowMs: 1, force: true })
        const first = h.snapshot()

        runRebuild({ ...h.deps, nowMs: 2, force: true })

        expect(h.snapshot()).toEqual(first)
      },
    ), { numRuns: 50 })
  }, REBUILD_PROPERTY_BUDGET_MS)
})
