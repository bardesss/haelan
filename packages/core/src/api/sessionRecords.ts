/**
 * The records a session holds, as opposed to the records a day holds.
 *
 * M6c's page answered "your best day for each metric", which tops out at a figure like total
 * calories - true, and not what anybody means by a personal best. A longest session, a furthest
 * one and a fastest kilometre are the records a person actually recognises, and the archive
 * supports all three: measured over 201 exercise sessions, 264 minutes, 12.85 km, and 5:08 drawn
 * from 263 one-kilometre splits.
 *
 * Pure, in `api/` beside the other three, so the arithmetic is testable without a database. The
 * reader's job is to parse `sessions.attrs` into the shape below and to drop excluded sessions
 * before calling this; see `query/allTime.ts`.
 */

export interface SessionForRecords {
  sessionId: string
  localDate: string
  /** As recorded, e.g. RUNNING or CARDIO_WORKOUT. Null when the payload carried none. */
  exerciseType: string | null
  durationMs: number
  /** Null for a session that recorded no distance, which is most of them. */
  distanceMm: number | null
  /**
   * Seconds for each split that covered exactly one kilometre.
   *
   * Exactly one kilometre, not any split: comparing a 400m lap against a 1km split would name
   * the shorter one fastest every time. Every split in this household's archive is a `DISTANCE`
   * split and no manual lap has ever been recorded (measured 2026-09-11), so in practice this is
   * every split a running session produced.
   */
  kilometreSeconds: number[]
}

export type SessionRecordKind = 'longest' | 'furthest' | 'fastest-km'

export interface SessionRecord {
  kind: SessionRecordKind
  sessionId: string
  localDate: string
  exerciseType: string | null
  /** Milliseconds for `longest`, millimetres for `furthest`, seconds for `fastest-km`. */
  value: number
}

/**
 * The three session records, omitting any the sessions cannot support.
 *
 * Omitted rather than reported as zero or null: a household that only lifts has a longest
 * session and no distance at all, and a card reading "furthest: none" is worse than no card.
 * Ties go to the earlier session, the same rule `recordOf` applies to a day - a record is when
 * you first did it.
 */
export function sessionRecordsOf(sessions: readonly SessionForRecords[]): SessionRecord[] {
  const records: SessionRecord[] = []

  const best = (
    kind: SessionRecordKind,
    valueOf: (session: SessionForRecords) => number | null,
    better: (candidate: number, incumbent: number) => boolean,
  ): void => {
    let found: SessionRecord | null = null
    for (const session of sessions) {
      const value = valueOf(session)
      if (value === null) continue
      const wins = found === null
        || better(value, found.value)
        || (value === found.value && session.localDate < found.localDate)
      if (wins) {
        found = {
          kind, sessionId: session.sessionId, localDate: session.localDate,
          exerciseType: session.exerciseType, value,
        }
      }
    }
    if (found !== null) records.push(found)
  }

  best('longest', (s) => s.durationMs, (a, b) => a > b)
  best('furthest', (s) => s.distanceMm, (a, b) => a > b)
  // Lower is better here, and it is the only one of the three that is.
  best('fastest-km', (s) => (s.kilometreSeconds.length === 0
    ? null
    : Math.min(...s.kilometreSeconds)), (a, b) => a < b)

  return records
}
