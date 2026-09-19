/**
 * Codes that mean the environment is broken rather than one page being bad.
 *
 * Matched as prefixes, because better-sqlite3 reports extended result codes: a failed write
 * arrives as SQLITE_IOERR_WRITE rather than SQLITE_IOERR, and listing every extension by hand
 * would leave the gaps this is meant to close.
 *
 * SQLITE_BUSY is here although it is transient. A rebuild holds the write lock for its whole run
 * (that is what the boot rebuild does), so contention during one means something else has the
 * file, and dropping every page one at a time against it would empty a person's archive over a
 * condition that will be gone on the next boot.
 */
const FATAL_PREFIXES = [
  'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOMEM', 'SQLITE_BUSY',
] as const

/**
 * Whether this error should abort the whole person rather than drop one page.
 *
 * Without it a full disk would make the replay drop every page in turn and then commit a
 * near-empty rebuild as though it were a data fault - stamping the person current, resuming their
 * sync, and reporting an archive that is simply gone. That is the silent corruption the whole
 * surfacing half exists to prevent, and these codes are the part of it this list can rule out
 * outright rather than leave to a count on a dashboard. Only the part: a code list closes the
 * conditions it names, and the breakers in replay.ts back it up for the rest without pretending
 * to cover everything.
 *
 * Reads the `code` property, never the message text. Messages are localised and reworded between
 * SQLite releases; codes are the stable contract.
 */
export function isFatalRebuildError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return false
  return FATAL_PREFIXES.some((prefix) => code.startsWith(prefix))
}
