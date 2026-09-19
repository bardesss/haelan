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

// What a person turned OFF, never what they turned on. The direction is load-bearing: the
// catalogue is behind the API by sixteen data types and a drift check exists to find more, so an
// inclusion list would arrive switched off for every person who already installed, silently, and
// defeat the check with the very mechanism meant to act on it. An empty set means everything.
//
// Its own table rather than a column on sync_state, which is fetch bookkeeping - cursors, windows,
// backfill marks. A person's choice is user intent, and this codebase keeps the two apart the way
// source_priority, source_aliases and overrides all do.
export const excludedDataTypes = sqliteTable('excluded_data_types', {
  personId: text('person_id').notNull().references(() => people.id),
  // Not a foreign key anywhere: the catalogue is code. A type removed from it should leave a
  // harmless orphan rather than block a migration.
  dataTypeId: text('data_type_id').notNull(),
  excludedAtMs: integer('excluded_at_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.personId, t.dataTypeId] })])

/**
 * What the last rebuild of this person did. Shaped after `sync_state` above, which is the
 * existing precedent for per-person operational state carrying an error and a failure count.
 *
 * Written from outside the person's rebuild transaction, never inside it. The failure path
 * exists to record a transaction that rolled back, and a write enlisted in that transaction
 * would roll back with it - see RebuildStateStore.
 */
export const rebuildState = sqliteTable('rebuild_state', {
  personId: text('person_id').primaryKey().references(() => people.id),
  lastAttemptAtMs: integer('last_attempt_at_ms'),
  lastSuccessAtMs: integer('last_success_at_ms'),
  lastErrorAtMs: integer('last_error_at_ms'),
  lastError: text('last_error'),
  // Increments on a quarantine, resets on any attempt that commits, including one that dropped
  // pages: a rebuild that committed is not a failed rebuild. It distinguishes a first occurrence
  // from a state that has survived many boots.
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  // Archived pages the last attempt could not replay and skipped, so the rest of the person's
  // archive could go in. Zero for a rebuild that skipped none, which is the ordinary case.
  droppedPages: integer('dropped_pages').notNull().default(0),
})

// Grouped, never one row per dropped page. A systematic fault drops every page of a type for the
// same reason, and an operator needs one readable line rather than thousands of identical rows.
// Page ids are not stored because nothing reads them: retry is a MAPPING_VERSION bump over the
// whole archive, never a list of ids.
//
// Replaced wholesale for a person at the END of each attempt. Clearing at the start would mean an
// attempt that then aborted had erased the previous record without writing a replacement.
export const rebuildDrops = sqliteTable('rebuild_drops', {
  personId: text('person_id').notNull().references(() => people.id),
  // Not a foreign key anywhere, for the reason excluded_data_types gives: the catalogue is code,
  // and a type removed from it should leave a harmless orphan rather than block a migration.
  dataType: text('data_type').notNull(),
  reason: text('reason').notNull(),
  pages: integer('pages').notNull(),
}, (t) => [primaryKey({ columns: [t.personId, t.dataType, t.reason] })])
