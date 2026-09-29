/**
 * The records a session holds, as opposed to the records a day holds.
 *
 * M6c's page answered "your best day for each metric", which tops out at a figure like total
 * calories - true, and not what anybody means by a personal best. A longest session, a furthest
 * one and a fastest kilometre are the records a person actually recognises, and the archive
 * supports all three: measured over 201 exercise sessions, 264 minutes, 12.85 km, and 5:08 drawn
 * from 263 one-kilometre splits.
 *
 * Pure, in `api/` beside the other three, so the arithmetic is testable without a database. A
 * reader parses each session through `sessionForRecords` below and drops excluded sessions before
 * calling this; see `query/allTime.ts` and `query/workoutPage.ts`.
 */
import { fastestEfforts } from './fastestEfforts.ts'
import type { EffortKey } from './fastestEfforts.ts'
import type { RoutePoint } from '../query/workoutDerived.ts'

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
  /** Fastest seconds over each distance anywhere inside the route (fastestEfforts); nulls when no route. */
  efforts: Record<EffortKey, number | null>
}

export type SessionRecordKind = 'longest' | 'furthest' | 'fastest-km' | 'fastest-mile' | 'fastest-5k'

export interface SessionRecord {
  kind: SessionRecordKind
  sessionId: string
  localDate: string
  exerciseType: string | null
  /** Milliseconds for `longest`, millimetres for `furthest`, seconds for each `fastest-*`. */
  value: number
}

/**
 * The session records, omitting any the sessions cannot support.
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
  // Lower is better for the fastest ones, and only for them. A kilometre is the quicker of the
  // splits and the GPS: the splits only ever time each kilometre from the start, while the GPS
  // finds the fastest one wherever it began, so neither alone is the fastest the session ran.
  const fewer = (a: number, b: number) => a < b
  best('fastest-km', (s) => {
    const candidates = [...s.kilometreSeconds, ...(s.efforts.km === null ? [] : [s.efforts.km])]
    return candidates.length === 0 ? null : Math.min(...candidates)
  }, fewer)
  best('fastest-mile', (s) => s.efforts.mile, fewer)
  best('fastest-5k', (s) => s.efforts.fiveK, fewer)

  return records
}

/**
 * One exercise session in the shape `sessionRecordsOf` needs, with the payload parsing kept here so
 * the Records page and the workout page's best cannot come to disagree about what a record is.
 *
 * `attrs` is JSON this process wrote but a mapper's shape rather than a schema, so every read
 * below is defensive: a session with no metricsSummary, no splits, or a split that is not a
 * kilometre is ordinary rather than broken. A zero distance and a zero-second split are dropped:
 * neither is a distance or a kilometre anybody ran.
 */
export function sessionForRecords(session: {
  id: string, localDate: string, startMs: number, endMs: number, attrs: unknown
}, route?: readonly RoutePoint[]): SessionForRecords {
  const attrs = typeof session.attrs === 'object' && session.attrs !== null && !Array.isArray(session.attrs)
    ? session.attrs as Record<string, unknown>
    : {}

  const summary = attrs['metricsSummary'] as { distanceMillimeters?: unknown } | null | undefined
  const distance = typeof summary?.distanceMillimeters === 'number' && summary.distanceMillimeters > 0
    ? summary.distanceMillimeters
    : null

  // Exactly one kilometre, so every candidate is the same distance: a 400m lap would win a
  // "fastest split" every time by being shorter rather than quicker.
  const kilometreSeconds: number[] = []
  const splits = Array.isArray(attrs['splits']) ? attrs['splits'] as unknown[] : []
  for (const split of splits) {
    const s = split as { splitType?: unknown, activeDuration?: unknown, metricsSummary?: { distanceMillimeters?: unknown } } | null
    if (s === null || typeof s !== 'object') continue
    if (s.splitType !== 'DISTANCE') continue
    if (s.metricsSummary?.distanceMillimeters !== 1_000_000) continue
    const seconds = Number.parseFloat(String(s.activeDuration ?? '').replace(/s$/, ''))
    if (Number.isFinite(seconds) && seconds > 0) kilometreSeconds.push(seconds)
  }

  return {
    sessionId: session.id,
    localDate: session.localDate,
    exerciseType: typeof attrs['exerciseType'] === 'string' ? attrs['exerciseType'] : null,
    durationMs: session.endMs - session.startMs,
    distanceMm: distance,
    kilometreSeconds,
    efforts: route === undefined ? { km: null, mile: null, fiveK: null } : fastestEfforts(route),
  }
}
