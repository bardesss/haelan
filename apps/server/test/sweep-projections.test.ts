import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { sweepStaleProjections } from '../src/mcp/sweepProjections.ts'

// Minor 3 of the M4 review: a crash mid sql_query leaves its projection - a plaintext copy of a
// person's own health data - in os.tmpdir() forever, since nothing else ever revisits that
// directory. This is the boot-time sweep index.ts runs to reclaim them.

let dir: string
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('sweepStaleProjections', () => {
  it('removes every haelan-sql- directory it finds, and reports how many', () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-sweep-test-'))
    const leftA = join(dir, 'haelan-sql-abc123')
    const leftB = join(dir, 'haelan-sql-def456')
    mkdirSync(leftA)
    writeFileSync(join(leftA, 'projection.db'), 'not a real database, just bytes to sweep')
    mkdirSync(leftB)

    expect(sweepStaleProjections(dir)).toBe(2)
    expect(existsSync(leftA)).toBe(false)
    expect(existsSync(leftB)).toBe(false)
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
