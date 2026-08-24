import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sessions } from '../db/schema/index.ts'

// Named WorkoutSession rather than a generic SessionRow: the reader also serves readSleepNights'
// underlying rows for kind 'sleep', but a workout list is its most interesting caller.
export interface WorkoutSession {
  id: string
  sourceId: string
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  localDate: string
  attrs: unknown
}

/**
 * Sessions of one kind in a local date range, oldest first.
 *
 * Sleep and exercise share one table and one natural key, so the kind filter is load bearing:
 * without it a sleep read and an exercise read would answer with the same rows.
 */
export function readSessions(db: DbOrTx, input: {
  personId: string
  kind: 'sleep' | 'exercise'
  from: string
  to: string
}): WorkoutSession[] {
  const rows = db.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.kind, input.kind),
    gte(sessions.localDate, input.from),
    lte(sessions.localDate, input.to),
  // id breaks a tie between two devices reporting a session at the same startMs, which startMs
  // alone leaves to sqlite's own unspecified order and flaps a snapshot or an ETag over rows that
  // did not actually change.
  )).orderBy(asc(sessions.startMs), asc(sessions.id)).all()

  return rows.map((row) => ({
    id: row.id,
    sourceId: row.sourceId,
    startMs: row.startMs,
    endMs: row.endMs,
    startOffsetMinutes: row.startOffsetMinutes,
    endOffsetMinutes: row.endOffsetMinutes,
    localDate: row.localDate,
    attrs: parseAttrs(row.attrs),
  }))
}

// attrs is stored as a JSON string so the schema does not have to know each provider's shape.
// Parsing it here means every caller gets a value rather than a string it has to remember to
// parse itself.
function parseAttrs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
