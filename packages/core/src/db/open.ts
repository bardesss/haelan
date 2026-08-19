import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'

export type Database = BetterSQLite3Database<Record<string, never>> & { $client: BetterSqlite3.Database }

export const DATABASE_FILENAME = 'haelan.sqlite'

export function openDatabase(dir: string): Database {
  mkdirSync(dir, { recursive: true })
  const client = new BetterSqlite3(join(dir, DATABASE_FILENAME))

  // WAL is what lets the MCP server, the CLI and a running sync share the file. Spec section 6
  // rejects DuckDB for precisely this reason.
  client.pragma('journal_mode = WAL')
  client.pragma('foreign_keys = ON')
  client.pragma('busy_timeout = 5000')

  return drizzle(client) as unknown as Database
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
