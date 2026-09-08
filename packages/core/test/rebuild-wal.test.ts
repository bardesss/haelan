import { describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { seedRebuildable } from '../src/testing/fixtures.ts'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import type { Database } from '../src/db/open.ts'

// The connection knows its own file, so this needs nothing from the fixture that it does not
// already expose.
const walBytes = (db: Database): number => {
  try {
    return statSync(`${db.$client.name}-wal`).size
  } catch {
    // A missing file and an empty one are the same answer to the question being asked.
    return 0
  }
}

describe('a rebuild reclaims the write-ahead log it produced', () => {
  it('leaves the log empty rather than at the size the rebuild grew it to', () => {
    const lab = seedRebuildable()
    try {
      // The measurement behind this was taken on an 882 MB database whose rebuild left a 769 MB
      // log behind. A fixture cannot reach that size, so what this proves is the mechanism - and
      // the pre-assertion is what stops it proving nothing: without it, the check below would pass
      // just as happily on a database nobody had ever written to.
      expect(walBytes(lab.db)).toBeGreaterThan(0)

      runRebuild({ ...lab.deps, nowMs: 1_770_000_000_000, force: true })

      // Zero, not merely smaller. A plain checkpoint copies pages back and keeps the file at its
      // high-water mark for reuse, which is the behaviour that left 769 MB sitting on disk;
      // "smaller than before" would pass for that too. Only the truncation reclaims it.
      expect(walBytes(lab.db)).toBe(0)
    } finally {
      lab.cleanup()
    }
  })
})
