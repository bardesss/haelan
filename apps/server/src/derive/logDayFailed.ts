import type { OnDayFailed } from '@haelan/core'

/** A day that fails on every drain is logged on its first failure and then once per this many. */
export const LOG_EVERY_FAILURES = 100

/**
 * runDerive's onDayFailed for every server caller: one line per failed day, under the caller's
 * own prefix, carrying the error's message and never the raw object. A poisoned day fails on
 * every drain, so repeats are logged sparingly, with the attempt count; an unknown count logs.
 */
export function logDayFailed(prefix: string): OnDayFailed {
  return (entry, error, failures) => {
    if (failures !== null && failures > 1 && failures % LOG_EVERY_FAILURES !== 0) return
    const line = `${prefix}: deriving ${entry.personId} ${entry.localDate} failed, ${error instanceof Error ? error.message : String(error)}`
    console.error(failures === null || failures <= 1 ? line : `${line} (${failures} attempts)`)
  }
}
