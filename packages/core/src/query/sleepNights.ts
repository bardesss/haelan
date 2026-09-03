import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sessions, sessionSegments } from '../db/schema/index.ts'
import { assembleNights, mainSleepOf, DEFAULT_NIGHT_GAP_MINUTES } from '../derive/sleep.ts'
import { SettingsStore } from '../store/settings.ts'

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
  /**
   * The start of every sleep session on this date that was not part of the night, in order. An
   * empty array is a measurement (we looked and there were none), which is why it is always
   * present rather than omitted for a night without any.
   */
  naps: number[]
  segments: NightSegment[]
}

/**
 * The sleep sessions in a local date range, one entry per night per source rather than one per
 * session.
 *
 * Which sessions belong to the same night is settled at derivation time by `derive/sleep.ts`:
 * every one of them carries the same `local_date`, computed once and stored, so grouping them
 * is a read of that column. The night's span is a second question, and the group does not answer
 * it. An afternoon nap carries the local date of the night before it, so a span taken from the
 * group's earliest start to its latest end runs from bedtime to the end of the nap: eight dates
 * in the reporting household's database came out that way, four of them 15 hours or longer.
 *
 * So the group goes through `assembleNights`, the same split the derivation pushes
 * sleep_bedtime_minutes and sleep_waketime_minutes from, and `startMs`, `endMs`, `sessionIds`
 * and `segments` describe the night alone while `naps` carries what did not join it. Shared
 * rather than reimplemented here, so a night on this route and a night in `daily` cannot come to
 * disagree; the gap it splits on is this instance's own `nightGapMinutes` for the same reason.
 *
 * A group whose sessions the source all marked as not the main sleep has no night, and reports
 * no entry rather than one manufactured from its naps. That matches the derivation, which writes
 * such a day a nap count and no bedtime at all.
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
  // The same (startMs, id) key assembleNights sorts on below, id breaking a tie between two
  // sessions sharing a startMs that startMs alone leaves to sqlite's own unspecified order. That
  // sort, not this clause, is now what gives sessionIds and naps their total order; ordering here
  // as well keeps the rows of one night arriving in one order rather than an unspecified one, so
  // the grouping below cannot flap a snapshot or an ETag over a night that did not change.
  )).orderBy(asc(sessions.startMs), asc(sessions.id)).all()

  if (sessionRows.length === 0) return []

  // The instance's own gap, read here rather than taken from the default, because a night
  // assembled at one gap and read back at another is two different nights. runDerive.ts and
  // runRebuild.ts read it the same way; the default stands in only for an instance that has not
  // been set up yet.
  const gapMinutes = new SettingsStore(db).get()?.nightGapMinutes ?? DEFAULT_NIGHT_GAP_MINUTES

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
      const { night, naps } = assembleNights({
        sessions: group.map((row) => ({
          id: row.id,
          sourceId: row.sourceId,
          startMs: row.startMs,
          startOffsetMinutes: row.startOffsetMinutes,
          endMs: row.endMs,
          endOffsetMinutes: row.endOffsetMinutes,
          mainSleep: mainSleepOf(row.attrs),
        })),
        gapMinutes,
      })
      if (night.length === 0) continue

      // The same four lines deriveSleepDay reads its bedtime and waketime from, over the same
      // group: the ends of a night are its earliest start and its latest end, which a piece
      // nested inside a longer one makes different from its first and last pieces.
      const start = Math.min(...night.map((s) => s.startMs))
      const end = Math.max(...night.map((s) => s.endMs))
      const first = night.find((s) => s.startMs === start)!
      const last = night.find((s) => s.endMs === end)!
      const ids = new Set(night.map((s) => s.id))

      nights.push({
        localDate: group[0]!.localDate,
        sourceId: group[0]!.sourceId,
        sessionIds: night.map((s) => s.id),
        startMs: start,
        endMs: end,
        startOffsetMinutes: first.startOffsetMinutes,
        endOffsetMinutes: last.endOffsetMinutes,
        naps: naps.map((s) => s.startMs),
        segments: segmentRows
          .filter((segment) => ids.has(segment.sessionId))
          .map((segment) => ({ stage: segment.stage, startMs: segment.startMs, endMs: segment.endMs })),
      })
    }
  }

  return nights.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.sourceId.localeCompare(b.sourceId))
}
