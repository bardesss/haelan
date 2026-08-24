import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sessions, sessionSegments } from '../db/schema/index.ts'

export interface NightSegment {
  stage: string
  startMs: number
  endMs: number
}

export interface Night {
  localDate: string
  sessionIds: string[]
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  segments: NightSegment[]
}

/**
 * The sleep sessions in a local date range, one entry per night rather than one per session.
 *
 * Nights are already assembled at derivation time by `derive/sleep.ts`: every session that
 * belongs to the same night carries the same `local_date`, computed once and stored, so this
 * reader only has to group by that column and order the segments underneath it. It does not
 * redo the gap based assembly itself.
 */
export function readSleepNights(db: DbOrTx, input: {
  personId: string
  from: string
  to: string
}): Night[] {
  const sessionRows = db.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.kind, 'sleep'),
    gte(sessions.localDate, input.from),
    lte(sessions.localDate, input.to),
  )).all()

  if (sessionRows.length === 0) return []

  // session_segments_session indexes (session_id, start_ms), so ordering here is the index order.
  const segmentRows = db.select().from(sessionSegments)
    .where(inArray(sessionSegments.sessionId, sessionRows.map((row) => row.id)))
    .orderBy(asc(sessionSegments.startMs))
    .all()

  const byDate = new Map<string, typeof sessionRows>()
  for (const row of sessionRows) {
    const group = byDate.get(row.localDate)
    if (group) group.push(row)
    else byDate.set(row.localDate, [row])
  }

  const nights: Night[] = []
  for (const [localDate, group] of byDate) {
    const first = group.reduce((earliest, row) => (row.startMs < earliest.startMs ? row : earliest))
    const last = group.reduce((latest, row) => (row.endMs > latest.endMs ? row : latest))
    const ids = new Set(group.map((row) => row.id))

    nights.push({
      localDate,
      sessionIds: group.map((row) => row.id),
      startMs: first.startMs,
      endMs: last.endMs,
      startOffsetMinutes: first.startOffsetMinutes,
      endOffsetMinutes: last.endOffsetMinutes,
      segments: segmentRows
        .filter((segment) => ids.has(segment.sessionId))
        .map((segment) => ({ stage: segment.stage, startMs: segment.startMs, endMs: segment.endMs })),
    })
  }

  return nights.sort((a, b) => a.localDate.localeCompare(b.localDate))
}
