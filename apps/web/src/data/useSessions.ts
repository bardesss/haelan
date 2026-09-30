import type { CardioLoad } from '@haelan/core/cardio-load'
import type { FilledSplit } from '@haelan/core/split-heart-rate'

// `attrs` is the provider's payload, kept whole and unparsed. The one decoder allowed to look
// inside it is packages/core/src/api/workoutSummary.ts, reached here through the
// @haelan/core/workout-summary subpath; nothing in this app reads a field out of it by hand.
export interface WorkoutSession {
  id: string
  sourceId: string
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  localDate: string
  attrs: unknown
  /** Whether the person excluded this session. The route serialises the reader's row unchanged
   *  (packages/core/src/query/sessions.ts), so this and excludeReason reach the client for free. */
  excluded: boolean
  excludeReason: string | null
  /**
   * Every source that recorded this workout, its own `sourceId` first, and the ids of the other
   * copies merged into it (packages/core/src/query/mergedWorkouts.ts). The server always sends
   * both. Optional here all the same, and read with a fallback wherever they are read: a demo
   * built from a capture older than the merge, or a response cached across the upgrade, carries
   * neither, and "one source, no other copies" is exactly what such a response meant.
   */
  sources?: string[]
  alternateIds?: string[]
}

/** One recorded GPS fix. Mirrors `RoutePoint` in packages/core/src/query/workoutDerived.ts field
 *  for field rather than importing it: that module pulls in drizzle and better-sqlite3, which have
 *  no business in a browser bundle, so this app defines its own wire-shape type for the response
 *  the same way it already does for WorkoutSession itself, just below. */
export interface RoutePoint {
  atMs: number
  latitude: number
  longitude: number
  altitudeMetres: number | null
  horizontalAccuracyMetres: number | null
  verticalAccuracyMetres: number | null
}

/** The by-id route (GET /p/:personId/sessions/:sessionId) carries these beside every other
 *  session field; the list route deliberately does not, which is why this extends WorkoutSession
 *  rather than being folded into it. `autoSplits` and `laps` are already filled from the
 *  session's own trace where the provider left a heart rate null - see splitHeartRate.ts - so
 *  this app never reads `detail.autoSplits` / `detail.laps` for rendering, only these. */
export interface WorkoutSessionDetail extends WorkoutSession {
  cardioLoad: CardioLoad | null
  autoSplits: FilledSplit[]
  laps: FilledSplit[]
  route: RoutePoint[]
}
