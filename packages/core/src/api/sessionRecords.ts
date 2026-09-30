/**
 * The records a session holds, as opposed to the records a day holds.
 *
 * M6c's page answered "your best day for each metric", which tops out at a figure like total
 * calories - true, and not what anybody means by a personal best. A longest session, a furthest
 * one and a fastest kilometre are the records a person actually recognises, and the archive
 * supports all three: measured over 201 exercise sessions, 264 minutes, 12.85 km, and 5:08 drawn
 * from 263 one-kilometre splits.
 *
 * Kept per category (exerciseCategory.ts), the way Strava, Garmin and Coros keep them: a ride's
 * distance never beats a run's, and a trail run, an incline run and a road run share one set.
 *
 * Pure, in `api/` beside the other three, so the arithmetic is testable without a database. A
 * reader parses each session through `sessionForRecords` below and drops excluded sessions before
 * calling this; see `query/allTime.ts` and `query/workoutPage.ts`.
 */
import { countsForDistanceRecords, exerciseCategory, isIndoor, RECORD_CATEGORY_ORDER } from './exerciseCategory.ts'
import type { ExerciseCategory } from './exerciseCategory.ts'
import { effortDistancesOf, fastestEfforts } from './fastestEfforts.ts'
import type { Efforts } from './fastestEfforts.ts'
import { workoutSummary } from './workoutSummary.ts'
import type { RoutePoint } from '../query/workoutDerived.ts'

export interface SessionForRecords {
  sessionId: string
  localDate: string
  /** As recorded, e.g. RUNNING or CARDIO_WORKOUT. Null when the payload carried none. */
  exerciseType: string | null
  durationMs: number
  /** Null for a session that recorded no distance, which is most of them. */
  distanceMm: number | null
  /** Null for a session that recorded no climb. */
  elevationGainMeters: number | null
  /**
   * Seconds for each split that covered exactly one kilometre.
   *
   * Exactly one kilometre, not any split: comparing a 400m lap against a 1km split would name
   * the shorter one fastest every time. Every split in this household's archive is a `DISTANCE`
   * split and no manual lap has ever been recorded (measured 2026-09-11), so in practice this is
   * every split a running session produced. Only a run's splits feed its fastest kilometre.
   */
  kilometreSeconds: number[]
  /**
   * Fastest seconds over each of the category's distances anywhere inside the route
   * (fastestEfforts), keyed as EFFORT_DISTANCES_BY_CATEGORY keys them; empty when there is no route
   * or the category reads none. A missing key reads as null.
   */
  efforts: Efforts<number | null>
}

/**
 * A record a session can hold: the longest, the furthest, the most climb, and the fastest over one
 * of its category's effort distances (`fastest-${key}`, e.g. 'fastest-5k' or 'fastest-40k').
 */
export type SessionRecordKind = 'longest' | 'furthest' | 'most-climb' | `fastest-${string}`

export interface SessionRecord {
  /** The category the record is held in: a ride never holds a run's record. */
  category: ExerciseCategory
  kind: SessionRecordKind
  sessionId: string
  localDate: string
  exerciseType: string | null
  /**
   * Milliseconds for `longest` (in whole seconds), whole metres for `furthest` and `most-climb`,
   * whole seconds for each `fastest-*`.
   */
  value: number
}

const fastestOf = (category: ExerciseCategory): SessionRecordKind[] =>
  effortDistancesOf(category).map(({ key }): SessionRecordKind => `fastest-${key}`)

/**
 * The records each category keeps, in the order a page lists them. A run and a ride keep a climb
 * and their fastest distances; a walk its distance and climb; a swim its distance alone (a swim's
 * fastest distances need lap data, parked); everything else only its longest session.
 */
export const RECORD_KINDS_BY_CATEGORY: Readonly<Record<ExerciseCategory, readonly SessionRecordKind[]>> = {
  run: ['longest', 'furthest', 'most-climb', ...fastestOf('run')],
  ride: ['longest', 'furthest', 'most-climb', ...fastestOf('ride')],
  walk: ['longest', 'furthest', 'most-climb'],
  swim: ['longest', 'furthest'],
  strength: ['longest'],
  cardio: ['longest'],
  other: ['longest'],
}

// In whole units, as they are printed, before a holder is picked: a GPS effort is fractional, and
// 241.4 s against a later 241.2 s would hand the later run a record both pages print as 4:01.
// Whole, the two tie and the earlier session keeps it. The same for metres of distance and climb,
// and the whole seconds of a longest session.
const whole = (value: number | null) => (value === null ? null : Math.round(value))

/**
 * One kind's value for a session, or null when it cannot hold that kind.
 *
 * `longest` counts every session of the category; the distance, climb and speed records only a
 * session whose type counts toward them (countsForDistanceRecords: no treadmill, no indoor or
 * electric bike), and the climb not an indoor one's either (isIndoor: an incline run's climb is the
 * treadmill's, which its workout page hides, so Records never links to a climb the page leaves out).
 * A run's fastest kilometre is the quicker of the splits and the GPS: the splits
 * only ever time each kilometre from the start, while the GPS finds the fastest one wherever it
 * began. A ride's split never makes a record: its distances are the GPS's alone.
 */
function valueOf(kind: SessionRecordKind, session: SessionForRecords): number | null {
  if (kind === 'longest') return Math.round(session.durationMs / 1000) * 1000
  if (!countsForDistanceRecords(session.exerciseType)) return null
  if (kind === 'furthest') return session.distanceMm === null ? null : whole(session.distanceMm / 1000)
  if (kind === 'most-climb') {
    if (isIndoor(session.exerciseType)) return null
    const climb = whole(session.elevationGainMeters)
    return climb === null || climb <= 0 ? null : climb
  }
  const key = kind.slice('fastest-'.length)
  const gps = session.efforts[key] ?? null
  const candidates = [
    ...(gps === null ? [] : [gps]),
    // Only a run has a 1 km distance, so a ride's splits never reach this.
    ...(key === '1k' ? session.kilometreSeconds : []),
  ]
  return candidates.length === 0 ? null : whole(Math.min(...candidates))
}

/**
 * The session records, one winner per category and kind, omitting any the sessions cannot support.
 *
 * Omitted rather than reported as zero or null: a household that only lifts has a longest
 * session and no distance at all, and a card reading "furthest: none" is worse than no card.
 * Ties go to the earlier session, the same rule `recordOf` applies to a day - a record is when
 * you first did it. Listed category by category in RECORD_CATEGORY_ORDER, each in its
 * kinds' order.
 */
export function sessionRecordsOf(sessions: readonly SessionForRecords[]): SessionRecord[] {
  const byCategory = new Map<ExerciseCategory, SessionForRecords[]>()
  for (const session of sessions) {
    const category = exerciseCategory(session.exerciseType)
    const members = byCategory.get(category)
    if (members === undefined) byCategory.set(category, [session])
    else members.push(session)
  }

  const records: SessionRecord[] = []
  for (const category of RECORD_CATEGORY_ORDER) {
    const kinds = RECORD_KINDS_BY_CATEGORY[category]
    const members = byCategory.get(category) ?? []
    for (const kind of kinds) {
      // Lower is better for the fastest ones, and only for them.
      const lower = kind.startsWith('fastest-')
      let found: SessionRecord | null = null
      for (const session of members) {
        const value = valueOf(kind, session)
        if (value === null) continue
        const wins = found === null
          || (lower ? value < found.value : value > found.value)
          || (value === found.value && session.localDate < found.localDate)
        if (wins) {
          found = {
            category, kind, sessionId: session.sessionId, localDate: session.localDate,
            exerciseType: session.exerciseType, value,
          }
        }
      }
      if (found !== null) records.push(found)
    }
  }
  return records
}

/** Whether a category reads efforts off a route at all: the ones with distances (run and ride). */
export function readsEfforts(category: ExerciseCategory): boolean {
  return effortDistancesOf(category).length > 0
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
  const attrs = attrsOf(session.attrs)

  // A figure filled from samples (query/fillFromSamples.ts) is an estimate, and an estimate never
  // sets a record: read as if the workout had not recorded it.
  const filled = Array.isArray(attrs['filled']) ? attrs['filled'] as unknown[] : []
  const summary = attrs['metricsSummary'] as { distanceMillimeters?: unknown } | null | undefined
  const distance = typeof summary?.distanceMillimeters === 'number' && summary.distanceMillimeters > 0
    && !filled.includes('distanceMillimeters')
    ? summary.distanceMillimeters
    : null

  // workoutSummary's own reading of the climb, the one the workout page's figure prints; a zero is no climb.
  const climb = filled.includes('elevationGainMillimeters') ? null : workoutSummary(attrs).elevationGainMeters
  const elevation = climb !== null && climb > 0 ? climb : null

  const exerciseType = typeof attrs['exerciseType'] === 'string' ? attrs['exerciseType'] : null
  return {
    sessionId: session.id,
    localDate: session.localDate,
    exerciseType,
    durationMs: session.endMs - session.startMs,
    distanceMm: distance,
    elevationGainMeters: elevation,
    kilometreSeconds: kilometreSplitsOf(attrs).map((split) => split.seconds),
    // Off the route with the category's own distances and jump speed; none for a category that reads none.
    efforts: route === undefined ? {} : fastestEfforts(route, exerciseCategory(exerciseType)),
  }
}

function attrsOf(attrs: unknown): Record<string, unknown> {
  return typeof attrs === 'object' && attrs !== null && !Array.isArray(attrs) ? attrs as Record<string, unknown> : {}
}

/**
 * Every split of a session's attrs that covered exactly one kilometre: its seconds, and how far
 * into the session it began (the distance of every split before it). The kilometres
 * sessionForRecords competes for a run's fastest-1k, so the workout page's kilometre can say where the
 * split it prints lay.
 *
 * Exactly one kilometre, so every candidate is the same distance: a 400m lap would win a
 * "fastest split" every time by being shorter rather than quicker.
 */
export function kilometreSplitsOf(sessionAttrs: unknown): { seconds: number, fromMeters: number }[] {
  const found: { seconds: number, fromMeters: number }[] = []
  const attrs = attrsOf(sessionAttrs)
  const splits = Array.isArray(attrs['splits']) ? attrs['splits'] as unknown[] : []
  let along = 0
  for (const split of splits) {
    const s = split as { splitType?: unknown, activeDuration?: unknown, metricsSummary?: { distanceMillimeters?: unknown } } | null
    if (s === null || typeof s !== 'object') continue
    const millimetres = s.metricsSummary?.distanceMillimeters
    const fromMeters = along
    if (typeof millimetres === 'number' && millimetres > 0) along += millimetres / 1000
    if (s.splitType !== 'DISTANCE') continue
    if (millimetres !== 1_000_000) continue
    const seconds = Number.parseFloat(String(s.activeDuration ?? '').replace(/s$/, ''))
    if (Number.isFinite(seconds) && seconds > 0) found.push({ seconds, fromMeters })
  }
  return found
}
