import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { PROJECTION_MIN_AGE_MS, sweepStaleProjections } from '../src/mcp/sweepProjections.ts'

/**
 * Backdates a directory past the sweep's age threshold, which is the only way a test can make one
 * look like the leftover of a crash rather than the working file of a query running right now.
 */
function age(path: string): void {
  const past = (Date.now() - PROJECTION_MIN_AGE_MS - 60_000) / 1000
  utimesSync(path, past, past)
}

// Minor 3 of the M4 review: a crash mid sql_query leaves its projection - a plaintext copy of a
// person's own health data - in os.tmpdir() forever, since nothing else ever revisits that
// directory. This is the boot-time sweep index.ts runs to reclaim them.

let dir: string
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('sweepStaleProjections', () => {
  it('removes every stale haelan-sql- directory it finds, and reports how many', () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-sweep-test-'))
    const leftA = join(dir, 'haelan-sql-abc123')
    const leftB = join(dir, 'haelan-sql-def456')
    mkdirSync(leftA)
    writeFileSync(join(leftA, 'projection.db'), 'not a real database, just bytes to sweep')
    mkdirSync(leftB)
    age(leftA)
    age(leftB)

    expect(sweepStaleProjections(dir)).toBe(2)
    expect(existsSync(leftA)).toBe(false)
    expect(existsSync(leftB)).toBe(false)
  })

  /**
   * The reason this sweep has an age at all, and it was measured rather than supposed.
   *
   * Without it the sweep was stale in name only. A probe that built a projection, started a query
   * against it, then ran the boot sweep exactly as `index.ts` does - no argument, so the machine's
   * real temp directory - reported `sweep removed 1 directories` and killed the query with
   * `Cannot open database because the directory does not exist`, a message naming neither the
   * sweep nor the cause.
   *
   * It is reachable two ways. In production, `TOOLS.md` documents reaching the stdio entry with
   * `docker exec` into the running container, so that process shares this one's temp directory and
   * a server restart sweeps a live stdio `sql_query` out from under itself. In this suite,
   * `boot.test.ts` spawns the real server while the sandbox and isolation files run `sql_query` in
   * other workers - which is the intermittent full-suite failure this test exists to have caught.
   */
  it('leaves a directory young enough to belong to a query running right now', () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-sweep-test-'))
    const live = join(dir, 'haelan-sql-livequery')
    mkdirSync(live)
    writeFileSync(join(live, 'projection.db'), 'a query in another process is reading this')

    // Freshly created, so by definition inside the window a live query could still own it.
    expect(sweepStaleProjections(dir)).toBe(0)
    expect(existsSync(live)).toBe(true)
  })

  it('leaves everything else in the temp directory alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-sweep-test-'))
    const unrelated = join(dir, 'some-other-apps-leftover')
    mkdirSync(unrelated)

    expect(sweepStaleProjections(dir)).toBe(0)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('answers zero rather than throwing when the directory does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-sweep-test-'))
    const missing = join(dir, 'does-not-exist')
    expect(sweepStaleProjections(missing)).toBe(0)
  })
})
