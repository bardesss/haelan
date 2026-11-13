import type { QueueEntry } from '@haelan/core'

/**
 * runDerive's onDayFailed for every server caller: one line per failed day, under the caller's
 * own prefix, carrying the error's message and never the raw object.
 */
export function logDayFailed(prefix: string): (entry: QueueEntry, error: unknown) => void {
  return (entry, error) => console.error(
    `${prefix}: deriving ${entry.personId} ${entry.localDate} failed, ${error instanceof Error ? error.message : String(error)}`,
  )
}
