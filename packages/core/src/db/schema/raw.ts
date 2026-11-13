import { sqliteTable, text, integer, blob, index, unique, primaryKey } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

// Append only. Tier 1 truth: tiers 2 and 3 are rebuilt from these bodies and are never the
// reason to re-fetch. Bodies are gzipped, because M0 measured 23 MB of raw JSON per person-day
// for heart rate alone.
export const rawPayloads = sqliteTable('raw_payloads', {
  id: text('id').primaryKey(),
  // Same narrow stand-in as people.ref and sources.ref: samples will carry this instead of the
  // 32 hex character id. `id` remains the archive's real index. See people.ref for why the
  // placeholder default is 0, and for the constraints that come with ref being this row's rowid.
  ref: integer('ref').notNull().unique().default(0),
  personId: text('person_id').notNull().references(() => people.id),
  dataType: text('data_type').notNull(),
  requestParams: text('request_params').notNull(),
  // Which fetch call produced this page. One listDataPoints call shares one value across every
  // page it paginates through, so a replay can put a call back together by reading the grouping
  // instead of inferring it from a null pageToken. Nullable, and null is not a gap to backfill:
  // it is the shape of every row archived before this column existed, and it means "fall back to
  // the pageToken inference". A live instance carries months of those and they are tier 1 truth,
  // so they have to keep replaying exactly as they do now. Deliberately not part of the body
  // hash unique constraint: every episode has a new value, so including it would end dedup and
  // archive the unchanged trailing window again on every single run.
  fetchEpisodeId: text('fetch_episode_id'),
  windowStartMs: integer('window_start_ms').notNull(),
  windowEndMs: integer('window_end_ms').notNull(),
  fetchedAtMs: integer('fetched_at_ms').notNull(),
  httpStatus: integer('http_status').notNull(),
  bodyGzip: blob('body_gzip', { mode: 'buffer' }).notNull(),
  bodyHash: text('body_hash').notNull(),
  bodyBytes: integer('body_bytes').notNull(),
}, (t) => [
  // windowStartMs is part of the key so an empty day and an unfetched day stay distinguishable;
  // without it, sixty unworn days collapse to one row and tier 3 can no longer be rebuilt from
  // tier 1. This only dedups correctly if sync windows are day aligned, since a trailing
  // "now minus seven days" window has a different start on every run and would defeat dedup
  // entirely. windowEndMs is also part of the key: two windows can share a start but differ in
  // end, and collapsing them would discard the wider fetch's record of having happened.
  unique('raw_payloads_body_hash').on(t.personId, t.dataType, t.bodyHash, t.windowStartMs, t.windowEndMs),
  index('raw_payloads_person_type_window').on(t.personId, t.dataType, t.windowStartMs),
  // RawArchive.put's newest-row lookup for a named companion upload, in listFor's order (fetch
  // time, then id): with id in the index the ORDER BY needs no sort of the person's rows.
  index('raw_payloads_person_type_fetched').on(t.personId, t.dataType, t.fetchedAtMs, t.id),
])

// Tier 1, survives a rebuild: a record the phone said was deleted. Nothing in the archive records a
// deletion, so a rebuild or a late upload would otherwise bring the record back.
export const companionDeletions = sqliteTable('companion_deletions', {
  personId: text('person_id').notNull().references(() => people.id),
  dataType: text('data_type').notNull(),
  recordId: text('record_id').notNull(),
  deletedAtMs: integer('deleted_at_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.personId, t.recordId] })])
