import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The prefix every `sql_query` projection directory carries (`makeProjectionDir`, runSql.ts).
 * Named once here rather than imported from there, so this sweep stays a boot-time concern with
 * no dependency on the sandbox module it is cleaning up after.
 */
const PROJECTION_PREFIX = 'haelan-sql-'

/**
 * Removes every leftover `sql_query` projection directory from the OS temp directory at boot.
 *
 * `makeProjectionDir` writes one of these per query, and its own `remove()` cleans up after an
 * ordinary run - but a crash mid-query (the process killed between `mkdtempSync` and the child's
 * `'exit'` handler ever running `remove()`) leaves the directory behind for good: nothing else
 * ever revisits `os.tmpdir()`. Each one is a projection of one person's own health data, in
 * plaintext, outside the data directory and outside any backup - a crash is not a few leaked
 * kilobytes, it is a copy of somebody's rows sitting in a world-readable temp directory
 * indefinitely.
 *
 * Boot is the right moment for this rather than, say, a periodic tick: it runs once, before this
 * process has had any chance to create a projection of its own, so it can never sweep a directory
 * a live query still holds open.
 *
 * Best-effort throughout, and silent per-directory. A boot sequence must not fail because one
 * leftover directory would not delete - the same `EPERM`-on-Windows hazard `makeProjectionDir`'s
 * own `remove()` already accepts (a lingering native handle from an unrelated process, or a
 * directory this process happens not to own) applies here just as much, and the OS temp directory
 * is reclaimed eventually regardless of what this sweep manages.
 *
 * `baseDir` is a parameter, not a hardcoded `os.tmpdir()`, purely so a test can point this at a
 * directory it controls rather than at the machine's real temp directory.
 */
export function sweepStaleProjections(baseDir: string = tmpdir()): number {
  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  } catch {
    // No temp directory to read is not this sweep's problem to raise; boot continues regardless.
    return 0
  }

  let swept = 0
  for (const entry of entries) {
    if (!entry.startsWith(PROJECTION_PREFIX)) continue
    try {
      rmSync(join(baseDir, entry), { recursive: true, force: true })
      swept += 1
    } catch {
      // Leaked, same as makeProjectionDir's own remove() accepts in exactly this situation.
    }
  }
  return swept
}
