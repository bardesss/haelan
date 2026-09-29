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
