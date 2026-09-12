import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * How old a projection directory must be before this sweep will touch it.
 *
 * Without this the sweep was stale in name only: it removed every `haelan-sql-*` directory in the
 * temp directory, including one that belonged to a **different process** and had a query running
 * against it. Measured - a probe that built a projection, started a query, then ran this sweep
 * exactly as `index.ts` does reported `sweep removed 1 directories` and killed the query with
 * `Cannot open database because the directory does not exist`, which names neither the sweep nor
 * the cause.
 *
 * The comment below is right that boot precedes *this* process's first projection. The hazard is
 * another process's: `TOOLS.md` documents reaching the stdio entry with `docker exec` into the
 * running container, so a server restart during a stdio `sql_query` sweeps that session's file
 * away. The same shape produced an intermittent failure in this repository's own suite, where
 * `boot.test.ts` spawns the real server while other workers run `sql_query`.
 *
 * Five minutes, against a query whose whole life is bounded by the 24ms build and the five second
 * deadline the sandbox enforces by killing its child: a sixty-fold margin over the longest a
 * directory can legitimately still be in use. The cost is only that a genuine leftover survives
 * until the first boot five minutes after the crash that made it, and the temp directory it sits
 * in is reclaimed by the OS regardless.
 */
export const PROJECTION_MIN_AGE_MS = 5 * 60_000

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
  const cutoff = Date.now() - PROJECTION_MIN_AGE_MS
  for (const entry of entries) {
    if (!entry.startsWith(PROJECTION_PREFIX)) continue
    const path = join(baseDir, entry)
    try {
      // Skipped rather than swept while it is young enough that a query in another process could
      // still be reading it. See PROJECTION_MIN_AGE_MS: deleting one of those kills the query
      // with an error that names neither this sweep nor the reason.
      if (statSync(path).mtimeMs > cutoff) continue
      rmSync(path, { recursive: true, force: true })
      swept += 1
    } catch {
      // A directory that vanished between the readdir and the stat is already gone, and one this
      // process may not delete is leaked - the same EPERM-on-Windows hazard makeProjectionDir's
      // own remove() accepts in exactly this situation.
    }
  }
  return swept
}
