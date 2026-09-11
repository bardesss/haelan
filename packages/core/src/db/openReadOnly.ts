import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { ConfigError } from '../errors.ts'
import { DATABASE_FILENAME } from './open.ts'
import type { Database } from './open.ts'

const JOURNAL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/meta/_journal.json')

interface JournalEntry { idx: number, tag: string, when: number }

/**
 * The `when` of the newest migration this build carries.
 *
 * drizzle writes that same number into `__drizzle_migrations.created_at` when it applies one, so
 * the two are directly comparable and no version column has to be invented for this.
 */
export function latestMigrationWhen(): number {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { entries: JournalEntry[] }
  const newest = journal.entries.at(-1)
  if (newest === undefined) throw new ConfigError('this build carries no migrations at all')
  return newest.when
}

/**
 * A read-only connection to an existing instance, for a process that is not the server.
 *
 * Deliberately not `openHaelan`. That one migrates and loads or creates the encryption key, and a
 * second process must do neither: migrating while the server is running is a corruption path, and
 * `loadOrCreateKey` against a stray directory writes a key nobody asked for.
 *
 * Every refusal below is a sentence rather than a raw SQLite error, because the caller is a
 * person reading a terminal after a `docker exec` that did not work.
 */
export function openReadOnly(dir: string): Database {
  const file = join(dir, DATABASE_FILENAME)
  if (!existsSync(file)) {
    throw new ConfigError(`no haelan database at '${file}'. Check HAELAN_DATA_DIR points at the instance's data directory.`)
  }

  let client: BetterSqlite3.Database
  try {
    client = new BetterSqlite3(file, { readonly: true, fileMustExist: true })
  } catch (err) {
    // SQLite cannot replay a write-ahead log on a read-only connection. Against a running
    // container this never happens, because the server is the writer and has already recovered
    // it; against a stopped instance it is the first thing that goes wrong, and the raw error
    // says "attempt to write a readonly database", which describes none of that.
    const code = (err as { code?: string }).code ?? ''
    if (code.startsWith('SQLITE_READONLY') || code === 'SQLITE_CANTOPEN') {
      throw new ConfigError(`'${file}' has a write-ahead log that needs recovering, and a read-only connection cannot do it. Start the instance once and try again.`)
    }
    if (isBusy(err)) throw new ConfigError(busyMessage(file))
    throw err
  }

  // Every refusal from here on holds an open connection, so the close lives in one place rather
  // than beside each throw. c842a92 fixed that leak by hand on the `prepare()` path; the pragma
  // below and the journal read further down can throw as well, and each was a second copy of it.
  try {
    // A rebuild wraps one person's entire re-derivation in a single transaction and holds SQLite's
    // only write lock for as long as that takes. Readers proceed under WAL; this bounds the wait
    // for the moments they do not, matching what openDatabase already sets for the server.
    client.pragma('busy_timeout = 5000')

    // `openDatabase` creates the physical file before `migrateToLatest` runs, so a migration that
    // fails leaves exactly this on disk: a file that exists but has never had a single migration
    // applied, and therefore has no `__drizzle_migrations` table at all. That is a distinct failure
    // from the table existing with zero rows (handled below via `onDisk === null`) - here the query
    // itself throws, and it has to be caught before it reaches the caller as a raw driver error.
    let onDisk: number | null
    try {
      const applied = client.prepare('select max(created_at) as newest from __drizzle_migrations')
        .get() as { newest: number | null } | undefined
      onDisk = applied?.newest ?? null
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      const message = err instanceof Error ? err.message : ''
      if (code === 'SQLITE_ERROR' && /no such table/i.test(message)) {
        onDisk = null
      } else if (isBusy(err)) {
        throw new ConfigError(busyMessage(file))
      } else {
        throw err
      }
    }
    const expected = latestMigrationWhen()
    if (onDisk === null || onDisk < expected) {
      throw new ConfigError(`the database at '${file}' is older than this build (migration ${onDisk ?? 'none'}, this build expects ${expected}). Start the instance once so it migrates, then try again.`)
    }
    if (onDisk > expected) {
      throw new ConfigError(`the database at '${file}' is newer than this build (migration ${onDisk}, this build expects ${expected}). It was written by a later version of haelan.`)
    }
  } catch (err) {
    client.close()
    throw err
  }

  return drizzle(client) as unknown as Database
}

// SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT and SQLITE_BUSY_RECOVERY all mean the same thing to whoever is
// reading the terminal, and better-sqlite3 puts each of them on `code` verbatim. admin.ts carries
// the same helper for the same reason, and core cannot import from apps/server.
function isBusy(err: unknown): boolean {
  return err instanceof Error && 'code' in err
    && typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY')
}

/**
 * The third failure mode the design asks to have a name, alongside the unrecovered log and the
 * version mismatch. Raw SQLite says `database is locked`, which says nothing about how long the
 * lock will last - and that is the only fact deciding whether waiting is sensible or whether
 * something is wrong.
 *
 * Worded for a read rather than for admin.ts's write. Nothing was going to be changed here, so
 * that message's opening reassurance does not apply, but the explanation of who holds the lock and
 * for how long is deliberately the same one.
 */
function busyMessage(file: string): string {
  return `the database at '${file}' is busy and did not come free. A rebuild wraps one person's `
    + "entire re-derivation in a single transaction and holds SQLite's only write lock for as long "
    + 'as that takes, which on a large instance is ten minutes or more. An upgrade that changed how '
    + 'data is derived starts one on boot. Wait for it to finish and try again.'
}
