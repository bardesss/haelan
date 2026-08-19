import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Database } from './open.ts'

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

export function migrateToLatest(db: Database): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
