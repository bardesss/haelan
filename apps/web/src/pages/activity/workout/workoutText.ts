import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { WORKOUT_ROUTE } from '../../../routes.js'

/** `WORKOUT_ROUTE`'s own `:sessionId` filled in, the same spelling NightRow.tsx's `nightPath`
 *  keeps for `NIGHT_ROUTE`: one function for every link to a workout, not a literal path typed
 *  again at each call site. */
export function workoutPath(sessionId: string): string {
  return WORKOUT_ROUTE.replace(':sessionId', encodeURIComponent(sessionId))
}

/**
 * The month a Records best was set in ("June", "juni"), with its year only when that is not the
 * year of the workout on screen: a best can be from any season of any year, and "June" alone
 * next to a September run is read as this June. Anchored at UTC midnight and read back in UTC,
 * formatLocalDate's own convention, so the month does not depend on the browser's zone.
 */
export function bestMonth(date: string, workoutDate: string, language: string): string {
  const otherYear = date.slice(0, 4) !== workoutDate.slice(0, 4)
  return new Date(`${date}T00:00:00Z`).toLocaleString(language, {
    month: 'long', timeZone: 'UTC', ...(otherYear ? { year: 'numeric' } : {}),
  })
}

// The provider's event kinds (workoutSummary.ts's WorkoutEvent): what stops the clock, and what
// starts it again. STOP is neither: it ends the workout.
const PAUSE_STARTS: ReadonlySet<string> = new Set(['PAUSE', 'AUTO_PAUSE'])
const RESUMES: ReadonlySet<string> = new Set(['START', 'RESUME', 'AUTO_RESUME'])
const STOP = 'STOP'
/**
 * How near the end a pause is read as the finish. Every PAUSE in this household's archive is part
 * of the finish sequence: PAUSE and STOP at the same instant, or STOP then PAUSE a second later,
 * all within two minutes of the session's end. Shaded, each drew a one-second "pause of 0:01".
 */
const FINISH_WINDOW_MS = 2 * 60_000

/**
 * A workout's real pauses from its events: each PAUSE up to the next START, RESUME or AUTO_RESUME,
 * as a span the trace shades. A pause is the finish, not a pause, when it begins within
 * FINISH_WINDOW_MS of `endMs` or when only STOP closes it: then nothing is drawn or counted. A
 * mid-session pause with nothing after it has only one end the archive supplies, so it stays a
 * mark at its instant rather than a span whose right edge this page would be making up
 * (IntradayHeartRate's own comment on `eventMarks`).
 */
export function pausesOf(events: readonly { atMs: number | null, kind: string | null }[], endMs: number): {
  spans: { startMs: number, endMs: number }[]
  marks: { atMs: number }[]
} {
  const timed = events
    .filter((e): e is { atMs: number, kind: string } => e.atMs !== null && e.kind !== null)
    .sort((a, b) => a.atMs - b.atMs)
  const spans: { startMs: number, endMs: number }[] = []
  let open: number | null = null
  for (const event of timed) {
    if (PAUSE_STARTS.has(event.kind)) {
      if (open === null && event.atMs < endMs - FINISH_WINDOW_MS) open = event.atMs
    } else if (event.kind === STOP) {
      open = null
    } else if (RESUMES.has(event.kind) && open !== null) {
      if (event.atMs > open) spans.push({ startMs: open, endMs: event.atMs })
      open = null
    }
  }
  return { spans, marks: open === null ? [] : [{ atMs: open }] }
}

/**
 * The height profile of a route as an SVG polyline's points in a `width` x `height` box: time
 * along, altitude up, the lowest point on the floor. Null below two points with an altitude, when
 * there is no profile to draw; a flat route draws a flat line through the middle.
 */
export function elevationProfile(
  route: readonly { atMs: number, altitudeMetres: number | null }[],
  width: number,
  height: number,
): string | null {
  const points = route.filter((p): p is { atMs: number, altitudeMetres: number } => p.altitudeMetres !== null)
  if (points.length < 2) return null
  const t0 = points[0]!.atMs
  const span = points.at(-1)!.atMs - t0
  const low = Math.min(...points.map((p) => p.altitudeMetres))
  const rise = Math.max(...points.map((p) => p.altitudeMetres)) - low
  return points.map((p, i) => {
    const x = span > 0 ? ((p.atMs - t0) / span) * width : (i / (points.length - 1)) * width
    const y = rise > 0 ? height - ((p.altitudeMetres - low) / rise) * height : height / 2
    return `${Number(x.toFixed(1))},${Number(y.toFixed(1))}`
  }).join(' ')
}

/**
 * Which of the three sentences about a route belongs under this workout's heading, or null for
 * the fourth case that gets none at all: a provider that said plainly there was nothing to record.
 *
 * Points decide first, regardless of `hasGps`: a session that carried points needs no sourcing
 * argument, the route is drawn on the page (WorkoutMap.tsx), and a Google session can never
 * reach this branch since the v4 API sends no route to carry (mapSessions.ts's own comment on
 * `route` says so). Only once there are none does `hasGps` speak - true is Google's own claim of a
 * route this API withholds, unchanged from what this sentence has always said.
 *
 * null says nothing, and used to say the wrong thing. `hasGps` is null for EVERY companion
 * session - Health Connect carries no such field, so this is the normal state rather than a signal
 * - which meant a sentence reading "a GPS route may have been recorded, this app was not able to
 * read it" printed under every workout synced from a phone, an indoor yoga session as readily as a
 * run. It was also false by then: the app could not read routes at all when that sentence was
 * written, and now asks for the permission and reads them.
 *
 * `routeConsentRequired` is the one thing that can be said about a session with no points, and it
 * is said before `hasGps` because it is the more specific claim. It means the phone found a track
 * and Health Connect would not release it, which is a different answer from "there was no route"
 * and the only one worth a sentence. The sentence used to add that the phone sync "cannot ask
 * for" the route, which stopped being true in android 0.4.0: the companion app requests
 * READ_EXERCISE_ROUTES (SyncEngine.kt). Not as "grant it and sync again", though, which a first
 * rewrite said: Health Connect ignores a request for that permission, and hands a background
 * reader ConsentRequired for another app's routes even under Always allow. What does release one
 * is the app's own Release routes button, which walks the withheld workouts in the foreground
 * through Health Connect's per-workout route screen - so that is what the sentence points at.
 *
 * Everything else with no points says nothing. That is deliberate and it replaced a sentence that
 * said the wrong thing: `hasGps` is null for EVERY companion session, so "a GPS route may have
 * been recorded, this app was not able to read it" used to print under every workout synced from a
 * phone, an indoor yoga session as readily as a run. A workout that reaches the end of this
 * function has no route points and nothing claiming one exists, which is overwhelmingly a workout
 * that had no route.
 */
export function gpsSentenceKey(detail: WorkoutDetail, routePointCount: number): string | null {
  if (routePointCount > 0) return 'activity.workout.gpsDrawn'
  if (detail.routeConsentRequired) return 'activity.workout.gpsConsentRequired'
  if (detail.hasGps === true) return 'activity.workout.gps'
  return null
}
