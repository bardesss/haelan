import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { RunResult } from 'better-sqlite3'

export type Database = BetterSQLite3Database<Record<string, never>> & { $client: BetterSqlite3.Database }

// A Drizzle transaction handle has no $client, so a store typed against Database cannot run
// inside one. Stores take this instead; only closeDatabase needs the real thing.
export type DbOrTx = BaseSQLiteDatabase<'sync', RunResult, Record<string, never>>

export const DATABASE_FILENAME = 'haelan.sqlite'

export function openDatabase(dir: string): Database {
  mkdirSync(dir, { recursive: true })
  const client = new BetterSqlite3(join(dir, DATABASE_FILENAME))

  // WAL is what lets the MCP server, the CLI and a running sync share the file. Spec section 6
  // rejects DuckDB for precisely this reason.
  client.pragma('journal_mode = WAL')
  client.pragma('foreign_keys = ON')
  client.pragma('busy_timeout = 5000')
  // How large the write-ahead log is allowed to stay on disk once a checkpoint has emptied it.
  //
  // SQLite auto-checkpoints roughly every 1000 pages, but only at a commit boundary, and a
  // checkpoint copies pages back into the database without shrinking the file - the space is kept
  // for reuse. That is the right default for a steady write load and the wrong one after a single
  // enormous transaction: a rebuild deletes and re-derives everything a person has inside one
  // transaction, so the log has to hold every page it dirties, and on a measured 882 MB database
  // it reached 769 MB. Without a limit it then stays that size forever, which is a surprise for
  // anyone backing the directory up.
  //
  // 64 MiB rather than 0: truncating to nothing on every checkpoint costs a file resize in the
  // steady state, where the log is a few megabytes and being reused constantly. This caps the
  // pathological case without taxing the ordinary one. runRebuild asks for a full truncation
  // separately, because after a rebuild even 64 MiB is worth reclaiming.
  client.pragma('journal_size_limit = 67108864')

  return drizzle(client) as unknown as Database
}

/**
 * Empties the write-ahead log and truncates the file to nothing.
 *
 * Call after a transaction large enough that the log it produced is worth reclaiming rather than
 * keeping for reuse - which today means a rebuild, and nothing else.
 *
 * Answers false when SQLite reports busy, which happens when another connection is mid-read: the
 * checkpoint then copies what it can and leaves the file alone. That is not a failure worth
 * propagating. The work the caller did is already committed, the next checkpoint reclaims the
 * space, and a rebuild that succeeded must never be reported as failed because a disk tidy-up was
 * blocked behind a reader.
 */
export function checkpointTruncate(db: Database): boolean {
  const rows = db.$client.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
  return rows[0]?.busy === 0
}

export function closeDatabase(db: Database): void {
  db.$client.close()
}

export function tableExists(db: Database, name: string): boolean {
  const rows = db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name = ${name}`,
  )
  return rows.length > 0
}
