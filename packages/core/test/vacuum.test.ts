import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import { databaseBloat } from '../src/db/maintenance.ts'
import { vacuumDecision, vacuumIfBloated } from '../src/db/vacuum.ts'

// Bloats a database past both thresholds the way production does: write a lot, delete it, and
// leave the freed pages on the freelist.
//
// Both thresholds measure bytes, so this buys bytes in the cheapest shape available: a few wide
// rows rather than many narrow ones. 200 rows of 400 KB clear the 64 MiB floor several times over,
// where narrow `metrics` rows need six figures of them and still land short without padding. One
// recursive CTE rather than a loop of statements, because this repo has twice had CI fail on the
// cost of its own tests and a helper two tests call is not the place to spend seconds.
//
// The floor is a fixed requirement, not a number this helper argues with. If it ever stops being
// cleared, the fix is more bytes here and never a smaller threshold there.
function bloated(): ReturnType<typeof createTestDatabase> {
  const test = createTestDatabase()
  test.db.$client.exec(`
    with recursive seq(x) as (
      select 0 union all select x + 1 from seq where x < 199
    )
    insert into metrics (name) select hex(randomblob(200000)) from seq
  `)
  test.db.run(sql`delete from metrics`)
  return test
}

describe('vacuumIfBloated', () => {
  it('reclaims the free pages and makes the file smaller, in bytes', () => {
    const test = bloated()
    try {
      const before = databaseBloat(test.db)
      expect(before.freeFraction).toBeGreaterThan(0.2)

      const outcome = vacuumIfBloated(test.db, test.dir)

      expect(outcome.ran).toBe(true)
      if (!outcome.ran) return
      expect(outcome.after.fileBytes).toBeLessThan(before.fileBytes)
      expect(outcome.after.freeBytes).toBe(0)
      expect(outcome.reclaimedBytes).toBe(before.fileBytes - outcome.after.fileBytes)
    } finally { test.cleanup() }
  })

  it('declines on a fresh database, naming the threshold it did not meet', () => {
    const test = createTestDatabase()
    try {
      const outcome = vacuumIfBloated(test.db, test.dir)
      expect(outcome.ran).toBe(false)
      if (outcome.ran) return
      expect(['below_fraction', 'below_floor']).toContain(outcome.reason)
    } finally { test.cleanup() }
  })

  it('declines when the disk cannot hold a second copy, and does not touch the file', () => {
    const test = bloated()
    try {
      // One byte short of what the margin demands, so the refusal is the margin's doing and not
      // an accident of a number picked far below it. A stub passed as the last argument, rather
      // than a spy on the maintenance module's export: an ES module namespace object is not
      // reliably writable, and a spy that silently failed to take would pass this test against
      // the real, plenty-large disk for the wrong reason.
      const live = databaseBloat(test.db).liveBytes
      const readFreeDisk = (): number => Math.floor(live * 1.2) - 1

      const before = databaseBloat(test.db)
      const outcome = vacuumIfBloated(test.db, test.dir, readFreeDisk)

      expect(outcome.ran).toBe(false)
      if (outcome.ran) return
      expect(outcome.reason).toBe('not_enough_disk')
      expect(databaseBloat(test.db).fileBytes).toBe(before.fileBytes)
    } finally { test.cleanup() }
  })
})

describe('vacuumDecision', () => {
  it('declines on the bloat gates before ever consulting disk, so a fresh database is never reported blocked on account of it', () => {
    // The route bug this guards: apps/server/src/routes/maintenance.ts used to compute the
    // disk-margin comparison on its own, with nothing stopping it from reporting "blocked" on a
    // database below_fraction would have declined for anyway. Failing this disk reader for any
    // size at all proves the gate order, not a number picked far below some real margin.
    const test = createTestDatabase()
    try {
      const decision = vacuumDecision(test.db, test.dir, () => 0)
      expect(decision.run).toBe(false)
      if (decision.run) return
      expect(decision.reason).not.toBe('not_enough_disk')
      expect(['below_fraction', 'below_floor']).toContain(decision.reason)
    } finally { test.cleanup() }
  })

  it('is what vacuumIfBloated itself declines with, not a second copy that could disagree', () => {
    const test = bloated()
    try {
      // One byte short of the margin, same as vacuumIfBloated's own "declines when the disk
      // cannot hold a second copy" test above - the gate both functions have to land on.
      const live = databaseBloat(test.db).liveBytes
      const readFreeDisk = (): number => Math.floor(live * 1.2) - 1

      const decision = vacuumDecision(test.db, test.dir, readFreeDisk)
      const outcome = vacuumIfBloated(test.db, test.dir, readFreeDisk)

      expect(decision.run).toBe(false)
      expect(outcome.ran).toBe(false)
      if (decision.run || outcome.ran) return
      expect(outcome.reason).toBe(decision.reason)
      expect(outcome.bloat).toEqual(decision.bloat)
    } finally { test.cleanup() }
  })
})
