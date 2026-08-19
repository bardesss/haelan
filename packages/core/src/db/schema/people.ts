import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core'

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  // Day boundaries are computed here, not in UTC. Spec invariant 3.
  timezone: text('timezone').notNull(),
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
