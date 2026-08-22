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

// One row per dirty person-day, not per metric: a day whose samples changed has to be
// recomputed for every metric anyway, and a per metric queue would be a hundred rows saying
// the same thing. Written by sync as it commits a window, by an override as it is added or
// removed, and by a derivation_version bump, which is what a rebuild is.
export const deriveQueue = sqliteTable('derive_queue', {
  personId: text('person_id').notNull().references(() => people.id),
  localDate: text('local_date').notNull(),
  queuedAtMs: integer('queued_at_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.personId, t.localDate] })])
