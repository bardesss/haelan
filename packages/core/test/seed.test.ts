import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { seedArchive, localMidnightMs } from '../src/testing/seed.ts'
import {
  rawPayloads, samples, daily, sessions, sessionSegments, sessionRoutes, observations,
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
      expect(test.db.select().from(sessionRoutes).all()).toEqual([])
      expect(test.db.select().from(observations).all()).toEqual([])
    } finally { test.cleanup() }
  })

  // Task 7: the demo is built from this generator, and it is public and permanent, so a route
  // reaching it would be a real coordinate published forever rather than a bug fixed on the next
  // capture. Checked rather than assumed - exercisePoint (this file) never writes a `route` key, so
  // mapSessions has nothing to read, but that is a fact about today's generator, not a guarantee
  // this test would notice breaking on its own without asserting it after a real rebuild.
  // openHaelan and runRebuild, not a raw payload check, for the same reason the anchor test above
  // rebuilds rather than inspects: session_routes is tier 2, and a route only exists once the app
  // has derived it, so asserting on the archive alone would prove nothing about what the demo's
  // own workout page could ever draw.
  it('seeds no workout route, even after the app rebuilds tier 2 from what it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-demo-no-route-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 14, endMs: END })
      const report = runRebuild({
        db: instance.db,
        archive: instance.archive,
        peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: END,
      })
      expect(report.failures).toEqual([])
      // At least one real exercise session exists to route through mapSessions at all - otherwise
      // an empty session table would pass this test for the wrong reason.
      expect(instance.db.select().from(sessions).where(eq(sessions.kind, 'exercise')).all().length)
        .toBeGreaterThan(0)
      expect(instance.db.select().from(sessionRoutes).all()).toEqual([])
    } finally { instance.close(); rmSync(dir, { recursive: true, force: true }) }
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
      const allRows = instance.db.select().from(daily).where(eq(daily.personId, 'p1')).all()
      const stepsRows = allRows.filter((r) => r.metric === 'steps' && r.agg === 'sum' && r.source === MERGED_SOURCE)
      const lastStepsRow = stepsRows.reduce((latest, row) => (
        latest === null || row.localDate > latest.localDate ? row : latest
      ), null as (typeof stepsRows)[number] | null)
      // 1 means all 24 of that day's local hours carry a sample - a whole day generated, not a
      // couple of hours' spillover from the UTC chunk after it.
      expect(lastStepsRow?.coverage).toBe(1)

      // steps is the reference, not because it is special, but because it is the one metric this
      // suite already trusted before this test existed: it is derived from real per-hour
      // timestamps during the rebuild, never from this file's own civilDateOf, so a bug in
      // civilDateOf has no way to reach it. Anchoring the rest of the check on it, rather than on
      // a second hardcoded date, is what makes this a check of every OTHER metric agreeing with
      // steps rather than two independently-guessed dates agreeing with each other.
      const referenceDate = lastStepsRow!.localDate

      // Every metric this run produced a `daily` row for, steps included, regardless of agg or
      // source: the newest-day regression this test exists to catch (civilDateOf reading a UTC
      // calendar date off an Amsterdam-local-midnight instant, one day early) does not care which
      // aggregate or which source a metric's row carries, only which civil date it landed on.
      // workout_count/workout_minutes are excluded on purpose, not overlooked: deriveExerciseDay
      // writes no row at all for a day with no session (its own comment: "absence is the whole
      // answer"), and this seed's workouts land on a fixed i % 3 === 1 schedule that need not
      // include this run's own last day - a day 3 span here never does. That is ordinary
      // sparseness, not the stamping bug, and asserting it away would make this test's pass
      // depend on `days` and the workout schedule lining up rather than on civilDateOf being
      // correct.
      const EXCLUDED_SPARSE_METRICS = new Set(['workout_count', 'workout_minutes'])
      const newestByMetric = new Map<string, string>()
      for (const row of allRows) {
        if (EXCLUDED_SPARSE_METRICS.has(row.metric)) continue
        const seen = newestByMetric.get(row.metric)
        if (seen === undefined || row.localDate > seen) newestByMetric.set(row.metric, row.localDate)
      }
      // Not vacuous: a query that matched nothing (a metric name typo'd out of existence, or a
      // rebuild that silently produced no daily rows at all) would otherwise pass this loop by
      // running zero iterations of it. 20 is comfortably under the ~30 metrics a 3 day run of
      // every data type this generator writes actually produces, so it is a floor against an empty
      // result, not a count this test is pinning.
      expect(newestByMetric.size).toBeGreaterThan(20)
      for (const [metric, newest] of newestByMetric) {
        // This is what the earlier, steps-only pin could not see: resting_heart_rate, daily_hrv,
        // respiratory_rate, floors and total_calories all filed their newest row under
        // referenceDate minus one day, because civilDateOf read dayStart's UTC calendar date
        // instead of its Amsterdam one. Naming the metric in the assertion message is what makes
        // a broken run's failure legible rather than a bare boolean.
        expect(newest, metric).toBe(referenceDate)
      }
    } finally {
      // Handles closed before the directory comes down: an open SQLite handle on Windows turns
      // rmSync's EPERM into the error a failing coverage assertion would otherwise report.
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
