import { sqliteTable, text, integer, real, unique, index } from 'drizzle-orm/sqlite-core'
import { people, sources } from './people.ts'
import { rawPayloads } from './raw.ts'

export const SAMPLE_AGGS = ['raw', 'min', 'mean', 'max', 'sum', 'count'] as const
export type SampleAgg = (typeof SAMPLE_AGGS)[number]

export const SESSION_KINDS = ['sleep', 'exercise', 'ecg'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

// Long and narrow. Heart rate arrives every 2 seconds, and agg lets a minute collapse to three
// rows (min, mean, max) rather than thirty, the reduction M0 measured. The ingest code that
// writes at that per-minute policy landed in M1b, in mapWindowSamples. The 2-second truth stays
// in raw_payloads either way, so this table is a cache that a rebuild can widen later without
// re-fetching.
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

// Tier 2, not events. events is tier 1, user-authored, and survives every rebuild; an
// observation is machine-written and a rebuild deletes and regenerates it. One table holding
// both would force a rebuild to delete some rows and keep others, let a person delete something
// the next sync recreates, and put machine-written rows on the Notes page as though somebody had
// typed them. That is why ObservationStore.deleteForPerson takes a person rather than a row: it
// exists for the rebuild path, which events has no equivalent of. Spec section 3, group C.
export const observations = sqliteTable('observations', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  sourceId: text('source_id').notNull().references(() => sources.id),
  // 'mood', 'symptom', 'ovulation_test', ... — the declared five, not a free string like events.kind.
  kind: text('kind').notNull(),
  startedAtMs: integer('started_at_ms').notNull(),
  startedAtOffsetMinutes: integer('started_at_offset_minutes').notNull(),
  // Null for a point observation. Must round-trip as null, not zero: a point has no end, and a
  // fabricated 0 would read back as an interval of length zero.
  endedAtMs: integer('ended_at_ms'),
  endedAtOffsetMinutes: integer('ended_at_offset_minutes'),
  // The same local-day rule every tier-2 row follows.
  localDate: text('local_date').notNull(),
  // Text, not a number: these are categories, and coercing "luteal" or "fatigue" to a number
  // would invent an ordering nothing measured.
  value: text('value'),
  rawPayloadId: text('raw_payload_id').references(() => rawPayloads.id),
}, (t) => [
  index('observations_person_date').on(t.personId, t.localDate),
])

export const daily = sqliteTable('daily', {
  personId: text('person_id').notNull().references(() => people.id),
  localDate: text('local_date').notNull(),
  metric: text('metric').notNull(),
  agg: text('agg').notNull(),
  // A source id, or the literal 'merged' when we computed the row by choosing between sources,
  // or 'provider' when the API only answers a figure it reconciled itself and we cannot inspect.
  source: text('source').notNull(),
  value: real('value'),
  // Fraction of the day's hours carrying at least one sample. Null where there is no basis to
  // measure it: a provider reconciled rollup has no samples underneath it, and a fabricated 1.0
  // would read as a fully observed day.
  coverage: real('coverage'),
  // Which sources the merged row drew on, and for how many of the day's hours:
  // [{"source":"a1b2","hours":18},{"source":"c3d4","hours":4}], hours descending. Written only
  // when source is 'merged'. Null on a per source row, which has no mix, and on a provider row,
  // whose mix Google performed and did not show us. Spec section 9 requires a merge decision to
  // be inspectable against the per source rows, and this is the half the row itself owes.
  sourceMix: text('source_mix'),
  derivationVersion: integer('derivation_version').notNull(),
  /**
   * When this row was last written. Nullable because rows derived before M3b have no honest
   * answer, and a fabricated one would make a client's "what changed since" skip real changes.
   */
  updatedAtMs: integer('updated_at_ms'),
}, (t) => [
  unique('daily_natural').on(t.personId, t.localDate, t.metric, t.agg, t.source),
  index('daily_person_metric_date').on(t.personId, t.metric, t.localDate),
  // A future change feed reads "what changed for this person since a moment", exactly the shape
  // WHERE person_id = ? AND updated_at_ms > ? scans, which no existing index covers.
  index('daily_person_updated').on(t.personId, t.updatedAtMs),
])
