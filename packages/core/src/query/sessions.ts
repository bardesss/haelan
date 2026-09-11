import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sessions, overrides as overridesTable } from '../db/schema/index.ts'
import { parseSessionTarget } from '../derive/targetKey.ts'
import { workoutSummary } from '../api/workoutSummary.ts'

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
  /**
   * Whether this person excluded this session. Marked rather than filtered: `workout_count` and
   * every other derived figure already drop it at derivation (applyToSessions), so a list that
   * dropped it too would leave a reader with a number that fell and no way to see what left. The
   * two disagreeing visibly is the point.
   */
  excluded: boolean
  /** The reason the person gave, so the list can say why rather than only that. */
  excludeReason: string | null
}

/**
 * Sessions of one kind in a local date range, oldest first.
 *
 * Sleep and exercise share one table and one natural key, so the kind filter is load bearing:
 * without it a sleep read and an exercise read would answer with the same rows.
 *
 * With no sourceId this answers with every device's sessions in range, the same "never choose
 * between sources" contract readSleepNights and readIntraday already give. Choosing between
 * sources stays the derive layer's job, applied once through its priority list; a caller that
 * wants one device's sessions asks for it explicitly instead.
 */
export function readSessions(db: DbOrTx, input: {
  personId: string
  kind: 'sleep' | 'exercise'
  from: string
  to: string
  sourceId?: string
  /**
   * A provider exercise type, from EXERCISE_TYPES. Applied after the blob is decoded rather than
   * as a json_extract predicate: `attrs` field names belong to workoutSummary, and a SQL
   * predicate naming them would be a second reader of the shape it is the only reader of.
   */
  type?: string
  /** At most the most recent match, applied after `type` so it cannot answer the wrong session. */
  latest?: boolean
}): WorkoutSession[] {
  const rows = db.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.kind, input.kind),
    gte(sessions.localDate, input.from),
    lte(sessions.localDate, input.to),
    input.sourceId === undefined ? undefined : eq(sessions.sourceId, input.sourceId),
  // id breaks a tie between two devices reporting a session at the same startMs, which startMs
  // alone leaves to sqlite's own unspecified order and flaps a snapshot or an ETag over rows that
  // did not actually change.
  )).orderBy(asc(sessions.startMs), asc(sessions.id)).all()

  // Read here rather than taken as a parameter: every caller of this reader wants the same answer,
  // and one that forgot to pass them would silently answer as though the person had corrected
  // nothing. Overrides are hand-entered and few, so this is one small indexed read.
  const excluded = new Map<string, string | null>()
  for (const row of db.select().from(overridesTable)
    .where(and(eq(overridesTable.personId, input.personId), eq(overridesTable.scope, 'session'))).all()) {
    if (row.action !== 'exclude') continue
    excluded.set(parseSessionTarget(row.targetKey), row.reason ?? null)
  }

  const mapped = rows.map((row) => ({
    id: row.id,
    sourceId: row.sourceId,
    startMs: row.startMs,
    endMs: row.endMs,
    startOffsetMinutes: row.startOffsetMinutes,
    endOffsetMinutes: row.endOffsetMinutes,
    localDate: row.localDate,
    attrs: parseAttrs(row.attrs),
    excluded: excluded.has(row.id),
    excludeReason: excluded.get(row.id) ?? null,
  }))

  // A session whose provider recorded no exercise type is never a match: "my last run" must not
  // be answered by a session nobody can say was a run.
  const matched = input.type === undefined
    ? mapped
    : mapped.filter((session) => workoutSummary(session.attrs).exerciseType === input.type)

  // The rows arrived oldest first, so the most recent is the last one, and taking it after the
  // type filter is what stops `latest` answering with a bike ride.
  return input.latest === true ? matched.slice(-1) : matched
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
