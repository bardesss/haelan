import { sqliteTable, text, integer, real, unique, index } from 'drizzle-orm/sqlite-core'
import { people, sources } from './people.ts'
import { rawPayloads } from './raw.ts'

export const SAMPLE_AGGS = ['raw', 'min', 'mean', 'max', 'sum', 'count'] as const
export type SampleAgg = (typeof SAMPLE_AGGS)[number]

export const SESSION_KINDS = ['sleep', 'exercise'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

// Long and narrow. Heart rate arrives every 2 seconds, and agg lets a minute collapse to three
// rows (min, mean, max) rather than thirty, the reduction M0 measured. The ingest code that
// actually writes at that per-minute policy has not landed yet; it arrives in M1b. The 2-second
// truth stays in raw_payloads either way, so this table is a cache that a rebuild can widen
// later without re-fetching.
export const samples = sqliteTable('samples', {
  personId: text('person_id').notNull().references(() => people.id),
  sourceId: text('source_id').notNull().references(() => sources.id),
  metric: text('metric').notNull(),
  utcMs: integer('utc_ms').notNull(),
  tzOffsetMinutes: integer('tz_offset_minutes').notNull(),
  agg: text('agg', { enum: SAMPLE_AGGS }).notNull(),
  // Nullable because a gap and a genuine zero must never render alike. Spec invariant 2.
  value: real('value'),
  n: integer('n').notNull(),
  rawPayloadId: text('raw_payload_id').references(() => rawPayloads.id),
}, (t) => [
  unique('samples_natural').on(t.personId, t.sourceId, t.metric, t.utcMs, t.agg),
  index('samples_person_metric_time').on(t.personId, t.metric, t.utcMs),
])

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  sourceId: text('source_id').notNull().references(() => sources.id),
  kind: text('kind', { enum: SESSION_KINDS }).notNull(),
  externalId: text('external_id').notNull(),
  // A session can begin and end under different UTC offsets, so one offset cannot describe both ends.
  startMs: integer('start_ms').notNull(),
  startOffsetMinutes: integer('start_offset_minutes').notNull(),
  endMs: integer('end_ms').notNull(),
  endOffsetMinutes: integer('end_offset_minutes').notNull(),
  // A night spanning midnight belongs to the morning. Spec invariant 3.
  localDate: text('local_date').notNull(),
  attrs: text('attrs').notNull(),
  rawPayloadId: text('raw_payload_id').references(() => rawPayloads.id),
}, (t) => [
  unique('sessions_natural').on(t.personId, t.sourceId, t.kind, t.externalId),
  index('sessions_person_kind_date').on(t.personId, t.kind, t.localDate),
])

export const sessionSegments = sqliteTable('session_segments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
}, (t) => [index('session_segments_session').on(t.sessionId, t.startMs)])

export const daily = sqliteTable('daily', {
  personId: text('person_id').notNull().references(() => people.id),
  localDate: text('local_date').notNull(),
  metric: text('metric').notNull(),
  agg: text('agg').notNull(),
  // The literal 'merged' rather than a source id, when this row is the merge of several.
  source: text('source').notNull(),
  value: real('value'),
  // Fraction of the day the underlying data actually covers. A number whose basis is unstated
  // invites a conclusion the data may not support.
  coverage: real('coverage').notNull(),
  derivationVersion: integer('derivation_version').notNull(),
}, (t) => [
  unique('daily_natural').on(t.personId, t.localDate, t.metric, t.agg, t.source),
  index('daily_person_metric_date').on(t.personId, t.metric, t.localDate),
])
