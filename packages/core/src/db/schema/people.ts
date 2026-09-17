import { sqliteTable, text, integer, unique, primaryKey } from 'drizzle-orm/sqlite-core'

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  // A narrow stand-in for `id` so `samples` (and anything else keyed on a person) can carry a
  // four-byte reference instead of repeating the text id. `id` stays the real identity; this
  // column has no meaning of its own. Default 0 is a placeholder that exists for the instant
  // between a row landing and the insert trigger (see the migration) overwriting it with the
  // table's rowid, which is what makes the column addition to an already-populated table legal
  // under SQLite's NOT NULL-needs-a-constant-default rule without colliding on the unique index.
  //
  // `ref` is this row's `rowid`, and code may rely on that. It follows that `INSERT OR REPLACE`
  // on this table is forbidden: that statement is a delete plus an insert, so it takes a new
  // rowid and silently re-issues this person's `ref`, which later tasks will have stored in
  // `samples`. No call site does this today; that is the point of writing it down now.
  // `ON CONFLICT DO UPDATE` is fine and leaves an existing ref alone. `INSERT ... RETURNING ref`
  // yields the placeholder 0, not the assigned ref, because RETURNING is computed before AFTER
  // triggers fire - read the ref back with a follow-up select instead. And a logical restore (a
  // `.dump` and replay, as opposed to a file copy) reassigns rowids while carrying `ref` values
  // verbatim, permanently diverging the two; whoever builds backup and restore must carry rowids
  // explicitly or reassign both together.
  ref: integer('ref').notNull().unique().default(0),
  displayName: text('display_name').notNull(),
  // Day boundaries are computed here, not in UTC. Spec invariant 3.
  timezone: text('timezone').notNull(),
  // A birthday, never an age. An age stored is an age that is wrong within the year, and every
  // reader of this column wants the age at the moment its number is computed - which is what
  // api/cardioLoad.ts's `ageAt` takes two local dates for.
  //
  // Null is load-bearing: with either of these absent, Banister answers null rather than a number
  // standing on a guess.
  //
  // Neither column invalidates a derived row, which is unusual for this table and is the reason it
  // is written down here. The only stored cardio load is Edwards, which reads zone minutes and
  // nothing else; Banister runs at read time on a workout. So these two are written like
  // display_name and not like timezone, which clears the derivation stamp in the same statement.
  // A future change that makes a stored metric depend on either column takes on that obligation at
  // the same moment.
  birthDate: text('birth_date'),
  sex: text('sex', { enum: ['male', 'female'] }),
  // How this person connects. True when they chose the phone path. Null on
  // rows predating the column, which reads as false: no choice was ever recorded
  // for them. The Google path needs no column: a credentials row for this person
  // is already that choice written down. The instance flag says only that the
  // wizard once closed without a client, never which member walks which path, so
  // two members of one instance can walk different ones and setup is done when at
  // least one of them walks any.
  companionPath: integer('companion_path', { mode: 'boolean' }),
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
  // Same narrow stand-in as people.ref, for the same reason: samples references a source many
  // times over, and four bytes beats the 32 hex characters of `id`. `id` remains the real
  // identity. See people.ref for why the placeholder default is 0, and for the constraints that
  // come with ref being this row's rowid.
  ref: integer('ref').notNull().unique().default(0),
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
