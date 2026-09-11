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
    // The constructor opens the file and never reads a page from it, so a failure here is about
    // reaching the file rather than about what is inside it.
    //
    // Not, despite the obvious guess, an unrecovered write-ahead log. SQLite has replayed a WAL on
    // a read-only connection since 3.22, creating the `-shm` itself, and this package's
    // better-sqlite3 carries 3.53 - measured against a database whose log was never checkpointed
    // and whose `-shm` was deleted, which opened and read the right rows. What is actually
    // reachable here is permissions and paths, and the likeliest of those is a data directory this
    // process cannot write: creating that `-shm` needs directory write permission even for a
    // reader, which is what a wrong uid on a mounted volume takes away inside a container.
    const code = (err as { code?: string }).code ?? ''
    if (code.startsWith('SQLITE_READONLY') || code === 'SQLITE_CANTOPEN') {
      throw new ConfigError(`cannot open '${file}' for reading. Check that the file and the directory holding it are readable by this process, and that the directory is writable: even a read-only connection creates a '-shm' file beside the database, so a data directory this user cannot write fails here.`)
    }
    if (isBusy(err)) throw new ConfigError(busyMessage(file))
    throw err
  }

  // Every refusal from here on holds an open connection, so the close lives in one place rather
  // than beside each throw.
  try {
    // A reader under a write-ahead log is not held up by a writer, so this is not the rebuild
    // wait `openDatabase` sets the same pragma for. It bounds the one wait a reader can still
    // meet: another connection replaying the log, which is milliseconds at boot.
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
 * Defensive rather than expected, and deliberately not admin.ts's message.
 *
 * admin.ts writes, so the rebuild's ten-minute transaction really does reach it. This function
 * reads, and under a write-ahead log a reader is not blocked by a writer at all: the rebuild's
 * long transaction, `VACUUM` and `wal_checkpoint(TRUNCATE)` each leave a newly arriving reader
 * unimpeded, and nothing in this codebase sets `locking_mode = EXCLUSIVE` outside the one test
 * that forces this branch open. What a reader can still meet is `SQLITE_BUSY_RECOVERY`, while
 * another connection replays the log - milliseconds at boot, not something to plan a wait around.
 *
 * Worth a sentence anyway, because raw SQLite says `database is locked`, which says nothing about
 * how long the lock lasts, and that is the only fact deciding whether trying again is sensible.
 */
function busyMessage(file: string): string {
  return `the database at '${file}' was busy and did not come free within five seconds. A reader `
    + 'is not held up by a writer here, so this is not a sync or a rebuild to wait out: what blocks '
    + 'one is another connection recovering the write-ahead log, which takes milliseconds. Try '
    + 'again, and if it happens twice the instance is not in the state it appears to be in.'
}
