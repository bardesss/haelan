import { ConfigError } from '../errors.ts'
import { MAX_RANGE_DAYS, rangeSpanDays } from './localDay.ts'

/**
 * The one sentence a range wider than MAX_RANGE_DAYS is refused with, or null when it is within
 * the limit or is not a range at all (a malformed or reversed one is refused by the date checks
 * that run first, whose messages name which date is wrong). The HTTP routes and the MCP tools both
 * answer through this, so the limit and its wording cannot drift between them.
 *
 * Its own module rather than in localDay.ts, which stays import free for the baseline-window
 * subpath; this one needs ConfigError.
 */
export function spanBeyondLimit(from: string, to: string, name = 'range'): string | null {
  const days = rangeSpanDays(from, to)
  if (!Number.isFinite(days) || days <= MAX_RANGE_DAYS) return null
  return `${name} '${from}'..'${to}' spans ${days} days, more than the ${MAX_RANGE_DAYS} day maximum`
}

/** spanBeyondLimit as a refusal: throws a ConfigError carrying that sentence. */
export function requireBoundedSpan(from: string, to: string, name = 'range'): void {
  const beyond = spanBeyondLimit(from, to, name)
  if (beyond !== null) throw new ConfigError(beyond)
}
