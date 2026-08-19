import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

export const syncState = sqliteTable('sync_state', {
  personId: text('person_id').notNull().references(() => people.id),
  dataType: text('data_type').notNull(),
  highWaterMs: integer('high_water_ms'),
  backfillCursorMs: integer('backfill_cursor_ms'),
  backfillCompleteAtMs: integer('backfill_complete_at_ms'),
  lastSuccessAtMs: integer('last_success_at_ms'),
  lastErrorAtMs: integer('last_error_at_ms'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.personId, t.dataType] })])
