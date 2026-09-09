import { sqliteTable, text, integer, real, unique, index } from 'drizzle-orm/sqlite-core'
import { people, sources } from './people.ts'
import { rawPayloads } from './raw.ts'

export const SAMPLE_AGGS = ['raw', 'min', 'mean', 'max', 'sum', 'count'] as const
export type SampleAgg = (typeof SAMPLE_AGGS)[number]

/**
 * What `samples.agg_ref` holds, instead of the four to five characters of the name.
 *
 * A constant rather than a dictionary table, unlike the metric name beside it: `SAMPLE_AGGS` is a
 * closed set decided in code, so a dictionary would be six rows and a join to express something
 * this map already expresses, and unlike a metric name a new aggregate cannot appear without a
 * code change anyway.
 *
 * **These numbers are permanent and must never be reordered or reused.** They are written into
 * 1.6 million rows, and nothing in the database records which number meant which name at the time
 * a row was written. Swapping two of them relabels every historical row silently: a minute's
 * minimum becomes its maximum with no constraint violated and no test failing on the row itself.
 * Adding an aggregate means taking the next unused number; retiring one means leaving its number
 * behind unused, not closing the gap.
 */
export const SAMPLE_AGG_REFS: Record<SampleAgg, number> = {
  raw: 1, min: 2, mean: 3, max: 4, sum: 5, count: 6,
}

const SAMPLE_AGG_BY_REF = new Map<number, SampleAgg>(
  SAMPLE_AGGS.map((agg) => [SAMPLE_AGG_REFS[agg], agg]),
)

/**
 * The reverse of `SAMPLE_AGG_REFS`. Returns undefined rather than guessing for a number no
 * release ever assigned, which is what a database written by a newer version would carry: a
 * caller that silently defaulted to 'raw' would report a stranger's minimum as a reading.
 */
export function sampleAggOf(ref: number): SampleAgg | undefined {
  return SAMPLE_AGG_BY_REF.get(ref)
}

export const SESSION_KINDS = ['sleep', 'exercise', 'ecg'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

// The dictionary samples.metric will reference instead of repeating a metric name ~14 characters
// long, 1.6 million times over. AUTOINCREMENT, not a bare INTEGER PRIMARY KEY: SQLite reuses the
// highest rowid of a plain INTEGER PRIMARY KEY once that row is deleted, and a reused ref would
// silently repoint every historical sample of a deleted metric onto whatever metric is inserted
// next — a heart rate becoming a body temperature, with nothing failing. Nothing deletes a metric
// today, which is exactly why this has to be decided now rather than discovered after it matters.
//
// Named `metricDictionary`, not the camelCase-of-the-table-name `metrics` the rest of this schema
// uses, because `METRICS` already means the derivation catalogue in `derive/metrics.ts`, and a
// module that imports both needs the names to say which is which.
export const metricDictionary = sqliteTable('metrics', {
  ref: integer('ref').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
})

// Long and narrow. Heart rate arrives every 2 seconds, and agg lets a minute collapse to three
// rows (min, mean, max) rather than thirty, the reduction M0 measured. The ingest code that
// writes at that per-minute policy landed in M1b, in mapWindowSamples. The 2-second truth stays
// in raw_payloads either way, so this table is a cache that a rebuild can widen later without
// re-fetching.
//
// Keyed on integers rather than the text identifiers it used to repeat. Five of the nine columns
// were an identifier written out in full on every row - a person id, a source id, a metric name,
// an aggregate name and a raw payload id - and on a measured 850 MB database that was 720 MB of
// the file once both indexes below are counted, for identifiers whose distinct values number in
// the tens. `SampleKeys` (packages/core/src/db/keys.ts) is the only thing that turns those
// integers back into names, and every reader and writer of this table goes through it.
//
// Every one of the four refs that has a parent table is a declared foreign key, and
// `openDatabase` sets `PRAGMA foreign_keys = ON` on every connection this package makes, so they
// are enforced rather than documentary. That is deliberate and it is not only about referential
// tidiness: `SampleKeys` caches in memory, so an instance reused across a transaction boundary
// answers from its cache for rows that rolled back, and without these constraints the resulting
// dangling number would be written with nothing failing at all. The constraints are what turn
// that silent corruption into an error at the insert. The parent columns are `ref` rather than
// each table's primary key, which SQLite allows because all four carry a unique index.
//
// `aggRef` is the exception and has no foreign key: it comes from the SAMPLE_AGG_REFS constant
// above, which has no parent table to point at.
export const samples = sqliteTable('samples', {
  personRef: integer('person_ref').notNull().references(() => people.ref),
  sourceRef: integer('source_ref').notNull().references(() => sources.ref),
  metricRef: integer('metric_ref').notNull().references(() => metricDictionary.ref),
  utcMs: integer('utc_ms').notNull(),
  tzOffsetMinutes: integer('tz_offset_minutes').notNull(),
  aggRef: integer('agg_ref').notNull(),
  // Nullable because a gap and a genuine zero must never render alike. Spec invariant 2.
  value: real('value'),
  n: integer('n').notNull(),
  rawPayloadRef: integer('raw_payload_ref').references(() => rawPayloads.ref),
}, (t) => [
  // The same five columns the natural key has always named, in the same order, now as refs. The
  // upsert in runJob.ts and replay.ts targets exactly this list, and the two have to move
  // together: a target naming a column combination no index covers throws on the second write of
  // a window rather than the first, which is a defect a single sync run cannot see.
  unique('samples_natural').on(t.personRef, t.sourceRef, t.metricRef, t.utcMs, t.aggRef),
  index('samples_person_metric_time').on(t.personRef, t.metricRef, t.utcMs),
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
