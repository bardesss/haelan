import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
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
  /**
   * At most the N most recent matches, applied after `type` so it cannot answer the wrong
   * session. Not the same operation as the HTTP route's `limit`, which is pagination — the first
   * N of an ascending list. This is the last N. They will eventually sit in one query string.
   */
  last?: number
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

  const excluded = readSessionExclusions(db, input.personId)
  const mapped = rows.map((row) => toWorkoutSession(row, excluded))

  // A session whose provider recorded no exercise type is never a match: "my last run" must not
  // be answered by a session nobody can say was a run.
  const matched = input.type === undefined
    ? mapped
    : mapped.filter((session) => workoutSummary(session.attrs).exerciseType === input.type)

  // The rows arrived oldest first, so the most recent N are the last N, and slicing after the
  // type filter is what stops `last` answering with a bike ride.
  return input.last === undefined ? matched : matched.slice(-input.last)
}

/**
 * One session by id, or null.
 *
 * Scoped by person as well as id. A session belonging to somebody else is null here, exactly as
 * an id that names nothing is, which is what lets the route answer 404 for both without ever
 * having to distinguish them: a 403 would confirm the id exists, and the caller asking is by
 * definition not entitled to that.
 *
 * No kind parameter, unlike readSessions, where the caller's kind is load bearing because a range
 * read of one kind would otherwise answer with the other's rows. An id already names exactly one
 * row, so a kind parameter here could only be passed wrongly.
 *
 * The table holds three kinds, not two: SESSION_KINDS is sleep, exercise and ecg. This reader
 * answers the first two and refuses the third, because WorkoutSession is the only shape it can
 * answer in and that shape has nothing to say about an ECG - no classification, no waveform, and
 * fourteen exercise attrs that would all read null. The list route already refuses `kind=ecg` for
 * exactly that reason; a by-id read that happily answered one would have made the two routes
 * disagree about whether an ECG is readable at all.
 *
 * Refused by answering null, not by throwing or by a distinct error: an ECG id is then
 * indistinguishable from an id that names nothing and from an id belonging to somebody else, all
 * three reaching the same 404. A caller who learned that an id was "an ECG, which this route does
 * not serve" would have learned that the id exists, which is the thing the person scoping above
 * exists to withhold.
 */
export function readSession(db: DbOrTx, input: {
  personId: string
  sessionId: string
}): WorkoutSession | null {
  const row = db.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.id, input.sessionId),
    inArray(sessions.kind, ['sleep', 'exercise']),
  )).get()
  if (row === undefined) return null
  return toWorkoutSession(row, readSessionExclusions(db, input.personId))
}

// Extracted from readSessions when readSession joined it. Two readers building this object from
// two literals is how one of them comes to omit a field the other has, and attrs is exactly the
// field a by-id reader would be tempted to hand back unparsed.
function toWorkoutSession(
  row: typeof sessions.$inferSelect,
  excluded: Map<string, string | null>,
): WorkoutSession {
  return {
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
  }
}

// Extracted for the same reason: readSession needs exactly the map readSessions builds, and a
// second copy of this loop would be a second place to forget the action filter.
//
// Read here rather than taken as a parameter: every caller of this reader wants the same answer,
// and one that forgot to pass them would silently answer as though the person had corrected
// nothing. Overrides are hand-entered and few, so this is one small indexed read.
function readSessionExclusions(db: DbOrTx, personId: string): Map<string, string | null> {
  const excluded = new Map<string, string | null>()
  for (const row of db.select().from(overridesTable)
    .where(and(eq(overridesTable.personId, personId), eq(overridesTable.scope, 'session'))).all()) {
    if (row.action !== 'exclude') continue
    excluded.set(parseSessionTarget(row.targetKey), row.reason ?? null)
  }
  return excluded
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
