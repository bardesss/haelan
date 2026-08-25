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
  sourceId: string
  sessionIds: string[]
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  segments: NightSegment[]
}

/**
 * The sleep sessions in a local date range, one entry per night per source rather than one per
 * session.
 *
 * Nights are already assembled at derivation time by `derive/sleep.ts`: every session that
 * belongs to the same night carries the same `local_date`, computed once and stored, so this
 * reader only has to group by that column and order the segments underneath it. It does not
 * redo the gap based assembly itself.
 *
 * Grouped by source as well as date. Two devices can each report a full night for the same local
 * date, and concatenating both into one Night would duplicate segments and attribute a blended
 * night to no device in particular. Choosing between sources is the derive layer's job, applied
 * once through its priority list when it writes the merged daily rows; this reader keeps every
 * source's night separate and lets a caller ask for one with `sourceId` if that is what it wants.
 */
export function readSleepNights(db: DbOrTx, input: {
  personId: string
  from: string
  to: string
  sourceId?: string
}): Night[] {
  const sessionRows = db.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.kind, 'sleep'),
    gte(sessions.localDate, input.from),
    lte(sessions.localDate, input.to),
    input.sourceId === undefined ? undefined : eq(sessions.sourceId, input.sourceId),
  // id breaks a tie between two sessions sharing a startMs, which startMs alone leaves to
  // sqlite's own unspecified order. sessionIds below is built straight from this fetch order, so
  // an unordered query here is an unordered sessionIds, which flaps a snapshot or an ETag over a
  // night that did not actually change.
  )).orderBy(asc(sessions.startMs), asc(sessions.id)).all()

  if (sessionRows.length === 0) return []

  // session_segments_session covers the IN lookup on session_id, but it is ordered
  // (session_id, start_ms), which sorts each session's own segments, not the merged list across
  // however many sessions make up a night. The order by below is what actually produces start
  // order across the group; sqlite still runs a sort step to get it.
  const segmentRows = db.select().from(sessionSegments)
    .where(inArray(sessionSegments.sessionId, sessionRows.map((row) => row.id)))
    .orderBy(asc(sessionSegments.startMs))
    .all()

  // Nested by date then by source, rather than one map keyed by a string built from both, so two
  // different local dates or sources can never collide on the same key.
  const byDate = new Map<string, Map<string, typeof sessionRows>>()
  for (const row of sessionRows) {
    const bySource = byDate.get(row.localDate) ?? new Map<string, typeof sessionRows>()
    byDate.set(row.localDate, bySource)
    const group = bySource.get(row.sourceId)
    if (group) group.push(row)
    else bySource.set(row.sourceId, [row])
  }

  const nights: Night[] = []
  for (const bySource of byDate.values()) {
    for (const group of bySource.values()) {
      const first = group.reduce((earliest, row) => (row.startMs < earliest.startMs ? row : earliest))
      const last = group.reduce((latest, row) => (row.endMs > latest.endMs ? row : latest))
      const ids = new Set(group.map((row) => row.id))

      nights.push({
        localDate: first.localDate,
        sourceId: first.sourceId,
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
  }

  return nights.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.sourceId.localeCompare(b.sourceId))
}
