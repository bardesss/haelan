import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

// How a day felt, 1 (bad) to 5 (great), one per person per local date (M9c). A daily score, not
// an event, so it is not an `events` row; M10 reads it as an outcome beside sleep and recovery.
export const moods = sqliteTable('moods', {
  personId: text('person_id').notNull().references(() => people.id),
  localDate: text('local_date').notNull(),
  score: integer('score').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (t) => [unique('moods_person_date').on(t.personId, t.localDate)])
