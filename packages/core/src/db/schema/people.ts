import { sqliteTable, text, integer, unique, primaryKey } from 'drizzle-orm/sqlite-core'

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  // Day boundaries are computed here, not in UTC. Spec invariant 3.
  timezone: text('timezone').notNull(),
  // What this person's tiers 2 and 3 were built with. Per person rather than instance wide,
  // because that is what makes an interrupted rebuild resumable: a person carrying the current
  // numbers is already done. Null on a database whose data predates M2e, which is the case the
  // milestone exists to fix, so null and a stale number lead to the same place.
  builtMappingVersion: integer('built_mapping_version'),
  builtDerivationVersion: integer('built_derivation_version'),
  createdAtMs: integer('created_at_ms').notNull(),
})

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  externalId: text('external_id').notNull(),
  displayName: text('display_name').notNull(),
  kind: text('kind', { enum: ['device', 'app', 'manual'] }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [unique('sources_person_external').on(t.personId, t.externalId)])

// Per person, per metric, which source wins. A `metric` of '*' is the person's default list, and
// a real metric name is a complete statement for that metric rather than an amendment to the
// default: mixing indices from two lists would rank sources by numbers that mean different
// things. Spec section 9: merging happens at derivation from a list the user configures.
export const sourcePriority = sqliteTable('source_priority', {
  personId: text('person_id').notNull().references(() => people.id),
  metric: text('metric').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  // Zero is best. Dense and contiguous by construction, because the store rewrites whole lists.
  rank: integer('rank').notNull(),
}, (t) => [primaryKey({ columns: [t.personId, t.metric, t.sourceId] })])

// Per person, the name this person gave a source. Its own table rather than an `alias` column on
// `sources` for exactly the reason source_priority is its own table: a rebuild regenerates
// `sources` from the archive and deletes the ones the archive no longer produces, and an alias is
// the one thing about a source that no rebuild can put back, because a person typed it.
//
// The unique index is not housekeeping. Two sources sharing a name make a picker that cannot be
// used and an ECharts legend that merges two series into one entry, so the collision is refused at
// the point it is created rather than handled at each of the places it would show up.
export const sourceAliases = sqliteTable('source_aliases', {
  personId: text('person_id').notNull().references(() => people.id),
  sourceId: text('source_id').notNull().references(() => sources.id),
  alias: text('alias').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (t) => [
  primaryKey({ columns: [t.personId, t.sourceId] }),
  unique('source_aliases_person_alias').on(t.personId, t.alias),
])
