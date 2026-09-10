import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { seedArchive, localMidnightMs } from '../src/testing/seed.ts'
import {
  rawPayloads, samples, daily, sessions, sessionSegments, observations,
} from '../src/db/schema/index.ts'
import { openHaelan } from '../src/instance.ts'
import { PeopleStore } from '../src/store/people.ts'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { MERGED_SOURCE } from '../src/derive/rollup.ts'

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
      // All five of the unit's derived tables, not the three the assertion here used to name:
      // observations and session_segments are as much a rebuild's output as samples, daily and
      // sessions are, and a seed that inserted a mood or a sleep stage directly would be exactly
      // the same defect this test exists to catch.
      expect(test.db.select().from(samples).all()).toEqual([])
      expect(test.db.select().from(daily).all()).toEqual([])
      expect(test.db.select().from(sessions).all()).toEqual([])
      expect(test.db.select().from(sessionSegments).all()).toEqual([])
      expect(test.db.select().from(observations).all()).toEqual([])
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
      for (const id of [
        'steps', 'heart-rate', 'weight', 'sleep', 'exercise',
        'daily-resting-heart-rate', 'daily-heart-rate-variability', 'daily-respiratory-rate',
      ]) {
        expect(types.has(id), id).toBe(true)
      }
    } finally { test.cleanup() }
  })

  it('closes on a completed local day when anchored at localMidnightMs, not a partial one', () => {
    // scripts/seed-demo.mjs anchors endMs with localMidnightMs rather than a bare Date.parse of
    // UTC midnight, exactly so this holds. A UTC-midnight anchor lets the last of this file's
    // UTC-day chunks straddle Amsterdam's own day boundary: the couple of hours past it spill
    // into a new local day nothing after endMs ever fills back in, which is what left the demo's
    // final Activity/Dashboard bar reading at 8.3% coverage - the right-hand edge a screenshot's
    // first glance lands on. Rebuilding through openHaelan and runRebuild here rather than
    // inspecting raw payloads directly, because coverage is a property of the derived `daily`
    // row, not of the archive this file writes.
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-demo-anchor-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      const endMs = localMidnightMs('2026-09-07')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 3, endMs })
      const report = runRebuild({
        db: instance.db,
        archive: instance.archive,
        peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: Date.now(),
      })
      expect(report.failures).toEqual([])

      // Read back whichever local day actually turns out to be the latest one with a steps row,
      // rather than asserting on a hardcoded date. A day one UTC-day chunk short of endMs (here,
      // 2026-09-06) is a full day either way this file anchors endMs - two overlapping chunks
      // cover it regardless - so naming that date would pass against the very UTC-midnight anchor
      // this test exists to catch. The day the anchor actually decides is whichever one comes out
      // latest: 2026-09-06 and nothing beyond it when endMs is local midnight, or a second,
      // 2026-09-07 row - the couple of hours spilled past that boundary - when it is not.
      const rows = instance.db.select().from(daily).where(and(
        eq(daily.personId, 'p1'),
        eq(daily.metric, 'steps'),
        eq(daily.agg, 'sum'),
        eq(daily.source, MERGED_SOURCE),
      )).all()
      const lastRow = rows.reduce((latest, row) => (
        latest === null || row.localDate > latest.localDate ? row : latest
      ), null as (typeof rows)[number] | null)
      // 1 means all 24 of that day's local hours carry a sample - a whole day generated, not a
      // couple of hours' spillover from the UTC chunk after it.
      expect(lastRow?.coverage).toBe(1)
    } finally {
      // Handles closed before the directory comes down: an open SQLite handle on Windows turns
      // rmSync's EPERM into the error a failing coverage assertion would otherwise report.
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
