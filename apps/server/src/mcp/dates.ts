import { z } from 'zod'
import { ConfigError, MAX_RANGE_DAYS, requireDate } from '@haelan/core'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/**
 * Whether a string names a day that exists, answered by core's own requireDate rather than a
 * second copy of its rule (the YYYY-MM-DD shape, then a round trip through the calendar that
 * refuses a thirtieth of February and keeps a real leap day), so the HTTP routes and the tools
 * cannot drift on what a date is.
 */
export function isCalendarDate(value: string): boolean {
  try {
    requireDate('date', value)
    return true
  } catch {
    return false
  }
}

/**
 * Every date a tool takes, so a malformed one is refused by the SDK's own input validation with a
 * message naming the field, rather than reaching date arithmetic and surfacing to the agent as a
 * raw RangeError. Callers add their own `.describe()`, which keeps the refinement.
 */
export const LOCAL_DATE = z.string()
  .regex(ISO_DATE, 'must be a YYYY-MM-DD local date')
  .refine(isCalendarDate, 'is not a date on the calendar')

/**
 * The cross field half, which a tool's input shape cannot carry: the shape is a raw shape (see
 * contract.ts), so a refinement across `from` and `to` has nowhere to attach there. Each ranged
 * tool runs it first thing in `run` through requireToolRange instead. The ceiling is core's
 * MAX_RANGE_DAYS, the one the HTTP routes bound by, so an agent cannot ask for more work than
 * the web app can.
 */
export const DATE_RANGE = z.object({ from: LOCAL_DATE, to: LOCAL_DATE }).superRefine(({ from, to }, ctx) => {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return
  if (from > to) {
    ctx.addIssue({ code: 'custom', message: `from '${from}' is after to '${to}'` })
    return
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
  if (days > MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: 'custom',
      message: `range '${from}'..'${to}' spans ${days} days, more than the ${MAX_RANGE_DAYS} day maximum`,
    })
  }
})

/** Refuses a malformed, inverted or too wide range as a ConfigError the adapter hands the agent as prose. */
export function requireToolRange(from: string, to: string): void {
  const result = DATE_RANGE.safeParse({ from, to })
  if (result.success) return
  throw new ConfigError(result.error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join('.')} ${issue.message}`))
    .join('; '))
}
