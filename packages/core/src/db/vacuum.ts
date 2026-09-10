import type { Database } from './open.ts'
import { checkpointTruncate } from './open.ts'
import type { DatabaseBloat } from './maintenance.ts'
import { BLOAT_FLOOR_BYTES, BLOAT_FRACTION, DISK_MARGIN, databaseBloat, freeDiskBytes } from './maintenance.ts'

export type VacuumOutcome =
  | { ran: true, before: DatabaseBloat, after: DatabaseBloat, reclaimedBytes: number, ms: number, checkpointed: boolean }
  | { ran: false, reason: 'below_fraction' | 'below_floor' | 'not_enough_disk', bloat: DatabaseBloat }

export type VacuumDecision =
  | { run: true, bloat: DatabaseBloat }
  | { run: false, reason: 'below_fraction' | 'below_floor' | 'not_enough_disk', bloat: DatabaseBloat }

/**
 * The three gates a vacuum has to clear, decided but not acted on: below_fraction and
 * below_floor mean there is nothing worth reclaiming yet, not_enough_disk means there is but this
 * machine cannot copy the file safely right now. Pulled out of vacuumIfBloated so a caller that
 * only wants to know the answer - the maintenance status route, which must not decide whether to
 * vacuum, only report what deciding would say - has exactly one place to ask, rather than a
 * second copy of the disk-margin comparison that can drift from the first the way
 * apps/server/src/routes/maintenance.ts once did.
 *
 * `readFreeDisk` defaults to `freeDiskBytes` and exists as a parameter only so a test can hand in
 * a stub: spying on `freeDiskBytes` through this module's own import of `maintenance.ts` reaches
 * for an ES module namespace object, which is not reliably writable, and a spy that silently does
 * nothing would leave this function's one dangerous branch untested while the suite stayed green.
 */
export function vacuumDecision(
  db: Database,
  dir: string,
  readFreeDisk: (path: string) => number = freeDiskBytes,
): VacuumDecision {
  const bloat = databaseBloat(db)
  if (bloat.freeFraction <= BLOAT_FRACTION) return { run: false, reason: 'below_fraction', bloat }
  if (bloat.freeBytes <= BLOAT_FLOOR_BYTES) return { run: false, reason: 'below_floor', bloat }
  if (readFreeDisk(dir) < bloat.liveBytes * DISK_MARGIN) {
    return { run: false, reason: 'not_enough_disk', bloat }
  }
  return { run: true, bloat }
}

/**
 * Hands the dead space back to the operating system, if there is enough of it to be worth a stall
 * and enough disk to do it safely.
 *
 * Synchronous, and that is the cost: better-sqlite3 blocks, so a vacuum is a pause on every
 * request for as long as it runs - measured at about 1.5 seconds on an 891 MB database. It runs
 * once per boot, after the rebuild has settled, which is the only moment this process is sure no
 * second connection is open on the file.
 *
 * A refusal is an outcome and not an exception. `not_enough_disk` especially: it is the state an
 * operator most needs told, and a caller that had to catch it would be catching a correct
 * decision.
 *
 * `VACUUM` in WAL mode writes its compacted pages into the write-ahead log; SQLite does not
 * truncate the main file at that commit, only at a checkpoint that shrinks it, which in the
 * ordinary run of things is whenever the last connection closes. Left there, this function would
 * report `reclaimedBytes` in the hundreds of megabytes while `ls`, `df` and the operator's own
 * disk usage graph kept showing the file at its old size for as long as the process stayed up -
 * which is the normal state, not an edge case. `checkpointTruncate` (open.ts) is the same call
 * `runRebuild` already makes for the identical reason, so `after` is measured once the bytes are
 * actually gone rather than once SQLite merely knows they could be.
 */
export function vacuumIfBloated(
  db: Database,
  dir: string,
  readFreeDisk: (path: string) => number = freeDiskBytes,
): VacuumOutcome {
  const decision = vacuumDecision(db, dir, readFreeDisk)
  if (!decision.run) return { ran: false, reason: decision.reason, bloat: decision.bloat }

  const started = Date.now()
  db.$client.exec('VACUUM')
  // Busy (another connection mid-read) is not a failure worth propagating here either, for the
  // same reason checkpointTruncate's own comment gives: the vacuum itself already committed, the
  // next checkpoint reclaims the space, and a vacuum that succeeded must never be reported as
  // failed because a truncate was blocked behind a reader.
  const checkpointed = checkpointTruncate(db)
  const after = databaseBloat(db)
  return {
    ran: true,
    before: decision.bloat,
    after,
    reclaimedBytes: decision.bloat.fileBytes - after.fileBytes,
    ms: Date.now() - started,
    checkpointed,
  }
}
