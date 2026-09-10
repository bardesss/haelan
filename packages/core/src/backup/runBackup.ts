import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from '../db/open.ts'
import { DISK_MARGIN, databaseBloat, freeDiskBytes } from '../db/maintenance.ts'

export const BACKUP_DIR_NAME = 'backups'
const PREFIX = 'haelan-'
const SUFFIX = '.sqlite'

export interface BackupFile { path: string, name: string, takenAtMs: number, bytes: number }

// Colons are not legal in a Windows filename and this project is developed there and shipped on
// Linux, so the ISO string's time separators become dashes. The result still sorts lexically in
// time order, which is what listBackups and pruneBackups both rely on instead of stat times -
// a copied or restored file carries whatever mtime the copy gave it.
const nameFor = (nowMs: number): string =>
  `${PREFIX}${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}${SUFFIX}`

// The inverse of nameFor. The ISO string's trailing Z is not a field - nameFor's replace never
// touches it - so it has to be dropped before the remaining dashes are split, or the millisecond
// group comes out as "000Z" and Date.parse, handed a second Z after the one this function adds
// back, returns NaN for every single backup ever taken. That failure is silent: nowMs still gets
// written into the returned BackupFile on the happy path, so runBackup's own return value never
// catches it. Only a caller that reads takenAtMs back through listBackups - which is what the
// retention schedule does - would ever see the NaN, and by then it looks like "no backup is ever
// due" rather than an error.
const takenAtFrom = (name: string): number => {
  const stamp = name.slice(PREFIX.length, -SUFFIX.length)
  const [date, time] = [stamp.slice(0, 10), stamp.slice(11, -1)]
  const [h, m, s, ms] = time.split('-')
  return Date.parse(`${date}T${h}:${m}:${s}.${ms ?? '000'}Z`)
}

const backupDir = (dir: string): string => join(dir, BACKUP_DIR_NAME)

/**
 * The completed backups, newest first.
 *
 * A file only appears here once it has been written, opened, integrity checked and renamed, so
 * "what backups do I have" and "what backups can I restore" are the same question. `.part` files
 * are deliberately invisible to this: they are the record of a failure, and a failure must not be
 * able to satisfy a schedule or fill a retention slot.
 */
export function listBackups(dir: string): BackupFile[] {
  const at = backupDir(dir)
  let names: string[]
  try { names = readdirSync(at) } catch { return [] }
  return names
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
    .map((name) => ({
      name, path: join(at, name), takenAtMs: takenAtFrom(name), bytes: statSync(join(at, name)).size,
    }))
    .sort((a, b) => b.name.localeCompare(a.name))
}

// Every table a rebuild cannot regenerate, plus the derived ones a reader actually looks at.
// Tier 1 is the part a backup exists for; samples, daily and sessions are here because a copy
// that silently lost 1.6 million rows while keeping every override would still pass a tier 1
// only check. daily and sessions are named by the spec and were missing: a copy that lost every
// derived day is a copy that opens to an empty dashboard, and it used to verify clean. people
// and sources are ours rather than the spec's, and stay - they are the rows every other table
// hangs off.
const COUNTED = [
  'people', 'sources', 'raw_payloads', 'overrides', 'notes', 'events', 'samples', 'daily', 'sessions',
]

/**
 * Opens a `.part` file read only and throws unless it is a well formed database holding the same
 * rows as `db`.
 *
 * The proof is an integrity check plus row counts, not a checksum. `VACUUM INTO` legitimately
 * produces different bytes from its source - that is what it is for - so the only honest question
 * is whether the copy is a well formed database holding the same rows.
 *
 * Exported, and taking a path rather than an open handle, so a test can call it directly against
 * a copy that is genuinely wrong - a live comparison, not a stub standing in for one - and so
 * runBackup can hand this same function to a caller as a default while still letting a test
 * replace it with one that fails on command. See runBackup below for why that seam exists.
 */
export function verifyBackup(partPath: string, db: Database): void {
  const name = basename(partPath).replace(/\.part$/, '')
  const counts = (run: (q: string) => unknown) => COUNTED.map((t) => run(`select count(*) c from ${t}`))
  const copy = new BetterSqlite3(partPath, { readonly: true })
  try {
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error(`the backup written to ${name} did not pass an integrity check`)
    }
    const theirs = counts((q) => copy.prepare(q).get())
    const ours = counts((q) => db.$client.prepare(q).get())
    if (JSON.stringify(theirs) !== JSON.stringify(ours)) {
      throw new Error(`the backup written to ${name} does not hold the same rows as the database`)
    }
  } finally { copy.close() }
}

export type BackupDecision =
  | { run: true }
  | { run: false, reason: 'backups_disabled' | 'not_enough_disk' }

/**
 * The one place both the nightly tick and the "back up now" button ask whether a backup should
 * run at all, for the same reason `vacuumDecision` is the one place a vacuum asks it - spec
 * section 1 makes B and C one unit precisely so there is a single disk-margin comparison to
 * disagree with itself.
 *
 * `keep <= 0` is decided here rather than left to `pruneBackups`: an operator who sets
 * `HAELAN_BACKUP_KEEP=0` to turn backups off, the way the README and config.ts's own floor say
 * they can, would otherwise still get a full compacted copy written on every tick and every
 * click, with only retention - which deletes nothing at `keep` 0 - standing between them and an
 * unbounded folder. That is the exact growth the button's own prune call exists to prevent; this
 * is what makes the setting mean what it says everywhere it is read, not only on the schedule.
 *
 * `VACUUM INTO` writes its compacted copy onto the same volume the live database and every kept
 * backup already sit on, so the size worth clearing is the live file's own bytes - what the new
 * copy will actually hold - with the same margin the boot vacuum uses for the same reason:
 * VACUUM builds a second copy before anything old is freed. `pruneBackups` only removes the
 * oldest kept backup after this one has already landed, so the instant after a successful write
 * is the peak, `keep + 1` copies sitting in the folder - but that peak is already the state the
 * free-space reading below measures: the `keep` already on disk are already spent against it, so
 * nothing here has to add them back in. This only has to clear the one copy this call is about
 * to add on top of what is already there.
 */
export function backupDecision(
  db: Database,
  dir: string,
  keep: number,
  readFreeDisk: (path: string) => number = freeDiskBytes,
): BackupDecision {
  if (keep <= 0) return { run: false, reason: 'backups_disabled' }
  const liveBytes = databaseBloat(db).liveBytes
  if (readFreeDisk(dir) < liveBytes * DISK_MARGIN) return { run: false, reason: 'not_enough_disk' }
  return { run: true }
}

/**
 * Writes a compacted copy, proves it, and only then gives it the name of a backup.
 *
 * `VACUUM INTO` rather than a file copy: it takes a read lock only, so this runs while the app is
 * live and while a sync is in flight, and the result is compacted rather than carrying the same
 * dead space the live file carries.
 *
 * The rename to the file's real name happens last, after `verify` passes: until then the only
 * thing on disk is a `.part`, which listBackups and pruneBackups both refuse to look at. That
 * ordering is the entire point of this function - see backup.test.ts for what breaks when it is
 * not honored.
 *
 * `verify` defaults to `verifyBackup` and exists as a parameter only so a test can hand in a stub
 * that fails on command - the same reason `vacuumIfBloated` takes `readFreeDisk`. Driving the real
 * `verifyBackup` into a genuine failure is exercised separately, directly, in backup.test.ts;
 * what a stub here proves is the contract around a failure, not the comparison itself: nothing
 * renamed, the `.part` still on disk, the error reaching the caller.
 */
export function runBackup(
  input: { db: Database, dir: string, nowMs: number },
  verify: (partPath: string, db: Database) => void = verifyBackup,
): BackupFile {
  const at = backupDir(input.dir)
  mkdirSync(at, { recursive: true })
  const name = nameFor(input.nowMs)
  const finished = join(at, name)
  const part = `${finished}.part`

  rmSync(part, { force: true })
  input.db.$client.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`)

  verify(part, input.db)

  renameSync(part, finished)
  return { name, path: finished, takenAtMs: input.nowMs, bytes: statSync(finished).size }
}

/**
 * Keeps the newest `keep` completed backups and deletes the rest, returning what it deleted.
 *
 * Counts only completed files. A `.part` never occupies a retention slot, because a run that fails
 * every night would otherwise evict every good backup it has and leave the operator with a folder
 * full of failures. A `.part` is removed only once a later backup has succeeded, so the most recent
 * failure is always still on disk to be looked at.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  const completed = listBackups(dir)
  const doomed = keep <= 0 ? [] : completed.slice(keep)
  for (const file of doomed) rmSync(file.path, { force: true })

  if (completed.length > 0) {
    const at = backupDir(dir)
    const newest = completed[0]!.name
    for (const name of readdirSync(at)) {
      if (name.endsWith('.part') && name < newest) rmSync(join(at, name), { force: true })
    }
  }
  return doomed.map((f) => f.name)
}
