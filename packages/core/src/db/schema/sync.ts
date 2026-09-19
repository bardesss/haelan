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
  // What the last rebuild actually left behind: every tier 2 and tier 3 row it wrote added
  // together - samples, sessions, session segments, observations and daily - each measured
  // against its table rather than summed from what the mappers returned (replayPerson's own
  // comment has the argument for the difference).
  //
  // Here because a rebuild can read an entire archive, write nothing, and raise nothing. Every
  // mapper treats a body it cannot parse or cannot recognise as an empty answer rather than an
  // error, which is the right call one level down - one unreadable body must not cost the rest of
  // the archive - but it means catalogue drift maps a whole archive to zero rows with no page
  // dropped, no breaker tripped and a clean success recorded here. The log already printed the
  // figures; nothing in the database held them, so the two web surfaces read an empty rebuild as
  // a healthy one and said so.
  //
  // A SUM, and therefore blind to partial drift. One data type drifting while the rest map fine
  // leaves this number large and healthy-looking, and nothing on either surface says a word. That
  // limitation is accepted rather than hidden: catching it needs a row count per data type, which
  // is the more thorough option issue 289 weighed and set aside. What this column catches is the
  // wholesale case, which is the one a MAPPING_VERSION bump is meant to fix and the one where the
  // operator was previously told there was nothing to fix.
  rowsWritten: integer('rows_written').notNull().default(0),
  // How many archived payloads carried at least one data point. NOT how many payloads there were,
  // and the distinction is the whole value of the column.
  //
  // api/client.ts archives a response before parsing it and unconditionally, so a 200 carrying an
  // empty dataPoints list is archived exactly like a full one. A connected member whose devices
  // reported nothing across the horizon therefore holds hundreds of payloads and derives zero
  // rows - perfectly healthy, and a count of pages would have flagged every one of them. Counting
  // only the bodies that actually carried points is what separates "the archive was empty" from
  // "the archive had data and none of it became rows", and only the second is worth a word.
  //
  // A body the envelope reader cannot read at all counts as carrying data, since a renamed
  // envelope is the drift this exists to catch. Payloads of a data type the catalogue has retired
  // do not: their bodies are never read, and unmappable_payloads is their counter.
  payloadsWithData: integer('payloads_with_data').notNull().default(0),
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
