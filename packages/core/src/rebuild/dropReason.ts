/** How much of an unrecognised message is kept. Long enough to identify a fault, short enough
 * that a thousand of them do not make the table unreadable. */
const MAX_REASON = 200

/**
 * The grouping key for one page's failure.
 *
 * `rebuild_drops` is keyed on (person, data type, reason), so this function decides how many rows
 * a fault produces. Both directions of getting it wrong are real: too literal and one systematic
 * fault writes a thousand near-identical rows, too aggressive and two genuinely different faults
 * merge into a line that misleads whoever reads it.
 *
 * The rule is to keep the constraint and drop the instance. A SQLite constraint message names
 * what was violated and which column, which is exactly the identity of the fault - "UNIQUE
 * constraint failed: session_segments.id", the one real example from #274, is already in that
 * form and is kept whole. What varies between two occurrences of the same fault is the row it
 * happened on, so a trailing rowid is stripped.
 *
 * Anything unrecognised is truncated and kept verbatim. A reason nobody can read is still a
 * better outcome than a group that merges two faults, because the count beside it is then a lie.
 */
export function dropReason(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : null
  if (message === null || message.length === 0) return 'unknown error'
  // The row a fault landed on is the one thing that differs between two occurrences of it.
  const withoutRow = message.replace(/\s*\(rowid\s+\d+\)\s*$/, '').trim()
  return withoutRow.length > MAX_REASON ? withoutRow.slice(0, MAX_REASON) : withoutRow
}
