import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from '../db/open.ts'

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

// Every table a rebuild cannot regenerate, plus the largest derived one. Tier 1 is the part a
// backup exists for; samples is here because a copy that silently lost 1.6 million rows while
// keeping every override would still pass a tier 1 only check.
const COUNTED = ['people', 'sources', 'raw_payloads', 'overrides', 'notes', 'events', 'samples']

/**
 * Writes a compacted copy, proves it, and only then gives it the name of a backup.
 *
 * `VACUUM INTO` rather than a file copy: it takes a read lock only, so this runs while the app is
 * live and while a sync is in flight, and the result is compacted rather than carrying the same
 * dead space the live file carries.
 *
 * The proof is an integrity check plus row counts, not a checksum. `VACUUM INTO` legitimately
 * produces different bytes from its source - that is what it is for - so the only honest question
 * is whether the copy is a well formed database holding the same rows. The rename to the file's
 * real name happens last, after both checks pass: until then the only thing on disk is a `.part`,
 * which listBackups and pruneBackups both refuse to look at. That ordering is the entire point of
 * this function - see backup.test.ts for what breaks when it is not honored.
 */
export function runBackup(input: { db: Database, dir: string, nowMs: number }): BackupFile {
  const at = backupDir(input.dir)
  mkdirSync(at, { recursive: true })
  const name = nameFor(input.nowMs)
  const finished = join(at, name)
  const part = `${finished}.part`

  rmSync(part, { force: true })
  input.db.$client.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`)

  const counts = (run: (q: string) => unknown) => COUNTED.map((t) => run(`select count(*) c from ${t}`))
  const copy = new BetterSqlite3(part, { readonly: true })
  try {
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error(`the backup written to ${name} did not pass an integrity check`)
    }
    const theirs = counts((q) => copy.prepare(q).get())
    const ours = counts((q) => input.db.$client.prepare(q).get())
    if (JSON.stringify(theirs) !== JSON.stringify(ours)) {
      throw new Error(`the backup written to ${name} does not hold the same rows as the database`)
    }
  } finally { copy.close() }

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
