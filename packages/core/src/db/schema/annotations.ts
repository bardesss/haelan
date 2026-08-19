import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  localDate: text('local_date').notNull(),
  body: text('body').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (t) => [unique('notes_person_date').on(t.personId, t.localDate)])

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  // User definable, so this is not an enum. Spec section 6 names illness, travel, alcohol,
  // medication, injury and caffeine as the seed set.
  kind: text('kind').notNull(),
  startedAtMs: integer('started_at_ms').notNull(),
  startedAtOffsetMinutes: integer('started_at_offset_minutes').notNull(),
  endedAtMs: integer('ended_at_ms'),
  endedAtOffsetMinutes: integer('ended_at_offset_minutes'),
  value: real('value'),
  note: text('note'),
})

export const overrides = sqliteTable('overrides', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  scope: text('scope', { enum: ['sample', 'session', 'day_metric'] }).notNull(),
  targetKey: text('target_key').notNull(),
  action: text('action', { enum: ['exclude', 'correct'] }).notNull(),
  correctedValue: real('corrected_value'),
  reason: text('reason').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [unique('overrides_person_target').on(t.personId, t.scope, t.targetKey)])
