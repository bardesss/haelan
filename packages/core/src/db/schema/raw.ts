import { sqliteTable, text, integer, blob, index, unique } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

// Append only. Tier 1 truth: tiers 2 and 3 are rebuilt from these bodies and are never the
// reason to re-fetch. Bodies are gzipped, because M0 measured 23 MB of raw JSON per person-day
// for heart rate alone.
export const rawPayloads = sqliteTable('raw_payloads', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  dataType: text('data_type').notNull(),
  requestParams: text('request_params').notNull(),
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
  // entirely.
  unique('raw_payloads_body_hash').on(t.personId, t.dataType, t.bodyHash, t.windowStartMs),
  index('raw_payloads_person_type_window').on(t.personId, t.dataType, t.windowStartMs),
])
