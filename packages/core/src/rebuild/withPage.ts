import { dropReason } from './dropReason.ts'
import { isFatalRebuildError } from './fatalError.ts'

/**
 * The connection underneath the transaction, which is all withPage needs.
 *
 * Structurally satisfied by better-sqlite3's own `Database`, so callers pass `db.$client`. Named
 * as a one-method interface rather than importing better-sqlite3's type because the one method is
 * genuinely all of it, and because that keeps this file out of the driver's type surface.
 *
 * `exec` rather than the transaction handle's `run`, and that is a memory fix - see the WHY on
 * withPage.
 */
export interface PageConnection {
  exec: (source: string) => unknown
}

export interface PageUnit {
  dataType: string
  /** How many archived pages this unit covers. One for a page, an episode's worth for samples. */
  pages: number
}

export interface Drop { dataType: string, reason: string, pages: number }

export interface DropCollector {
  /** Grouped (dataType, reason) -> pages. */
  readonly drops: Map<string, Drop>
  droppedPages: number
  /** Drops since the last unit that committed. Backs the breaker in replayPerson. */
  consecutive: number
  /**
   * The reason the most recent drop gave, or null before there is one.
   *
   * Kept separately because `list()` cannot answer it: that returns the groups in the order each
   * was first seen, so with faults A, B, A its last entry is B while the last drop was an A. The
   * breaker quotes this in the message an operator reads, and quoting the wrong fault sends them
   * looking at the wrong thing.
   */
  lastReason: string | null
  record(unit: PageUnit, error: unknown): void
  succeeded(): void
  list(): Drop[]
}

export function makeDropCollector(): DropCollector {
  const drops = new Map<string, Drop>()
  return {
    drops,
    droppedPages: 0,
    consecutive: 0,
    lastReason: null,
    record(unit, error) {
      const reason = dropReason(error)
      this.lastReason = reason
      // A plain space cannot separate these unambiguously: a dataType of "a b" and reason "c"
      // would key identically to dataType "a" and reason "b c". Today's dataTypes are URL path
      // segments (see PageUnit), which cannot contain a space, so the collision cannot fire yet -
      // but nothing enforces that here, and \u001f (ASCII unit separator) is not a character
      // either a dataType or a human-readable SQLite error message would ever contain, which a
      // plain space very much is.
      const key = `${unit.dataType}\u001f${reason}`
      const existing = drops.get(key)
      if (existing) existing.pages += unit.pages
      else drops.set(key, { dataType: unit.dataType, reason, pages: unit.pages })
      this.droppedPages += unit.pages
      this.consecutive += 1
    },
    succeeded() {
      // Consecutive, not total. An archive with scattered bad pages must never trip the breaker,
      // and only an unbroken run of failures says the environment rather than the data is wrong.
      this.consecutive = 0
    },
    list() {
      return [...drops.values()]
    },
  }
}

// A name of our own, deliberately not drizzle's `sp${nestedIndex}`. See the WHY comment on
// withPage for what depending on drizzle's naming would have cost.
const SAVEPOINT_NAME = 'haelan_page'

/**
 * Runs one unit's writes inside a savepoint, so a failure costs that unit and nothing else.
 *
 * Returns whether the unit committed. The caller reads that rather than catching, which is what
 * keeps the breaker's bookkeeping in one place.
 *
 * A fatal error is rethrown, before any recovery statement runs, rather than recorded: a full
 * disk or a wedged connection means SQLite itself may not be able to service a `rollback to`
 * either, and issuing one against it risks replacing the real error with a confusing secondary
 * one. Dropping every unit against a fatal condition would also commit a near-empty rebuild that
 * stamps the person current - the outer transaction discards everything anyway once this rethrows,
 * so there is nothing to clean up here. See isFatalRebuildError.
 *
 * ## Why this owns the savepoint rather than calling drizzle's nested `tx.transaction()`
 *
 * The obvious way to write this is `tx.transaction(() => fn())` and let drizzle manage the
 * savepoint. That does not work here, for two compounding reasons visible in
 * `drizzle-orm/better-sqlite3/session.js`'s `BetterSQLiteTransaction.transaction`:
 *
 * 1. On its error path drizzle issues `rollback to savepoint spN` and rethrows, with no matching
 *    `release`. SQLite deliberately leaves a rolled-back-to savepoint on the stack (so it can be
 *    rolled back to again), so without an explicit release every dropped unit leaks one entry,
 *    and a systematic fault stacks thousands of them inside one transaction.
 * 2. The name it picks, `sp${this.nestedIndex}`, comes from how many transaction levels deep the
 *    *caller* already is, not from how many sibling calls came before it - it does not advance
 *    between one dropped unit and the next. `replayPerson` already runs inside one
 *    `db.transaction()`, which makes the caller's `nestedIndex` 0, so drizzle would name every
 *    unit's savepoint `sp0`. A companion helper could then patch a leaked one at a time with
 *    `release savepoint sp0`, but that number is only right while replayPerson's own call depth
 *    never changes, and nothing would fail if it did except a runtime "no such savepoint" the
 *    first time this ran at a different depth.
 *
 * Issuing the savepoint under a name of our own sidesteps both: the name never depends on where
 * the caller sits, and every path below - success, a dropped unit, and a fatal rethrow - accounts
 * for exactly the one `savepoint` this call opened. That argument is about the savepoint, not
 * about which handle issues it, and it is why this helper takes no transaction handle at all -
 * the next section is why the statements go to the connection instead.
 *
 * Only `fn()` is inside the `try`. The success-path `release` and `collector.succeeded()` run
 * after it, unguarded: if either of those threw while still inside the `try`, the `catch` below
 * would treat that as fn()'s own failure and issue `rollback to savepoint` - against a savepoint
 * that a successful `release` had already popped, and that no longer exists to roll back to.
 *
 * ## Why the connection's `exec`, and not the transaction handle's `run`
 *
 * The three statements below started life as `tx.run(sql.raw(...))`, which is the leak #275 was
 * about, reopened one level up. Drizzle compiles and prepares a fresh better-sqlite3 statement on
 * every `run()`, better-sqlite3 holds what a connection prepares, and nothing inside a long
 * transaction releases any of it - the same mechanism, and the same fix, as the `insertSample`
 * hoist in replay.ts. Measured here on drizzle-orm 0.45.2, 100,000 units inside one transaction,
 * two statements each: RSS 196.7 -> 608.4 MB, about 4.3 KB a unit, JS heap flat throughout and
 * no part of it returned by an explicit gc(). The same loop through `exec` grew RSS by 0.3 MB.
 *
 * `exec` prepares, steps and finalises internally, so it leaves nothing behind to accumulate, and
 * there is no statement object for this helper to own, cache or accidentally carry to a second
 * connection. Hoisting three prepared statements instead also holds flat and is faster (146 ms
 * against 242 ms over those 100,000 units), and that difference - under a microsecond a unit -
 * is nothing beside the mapping and the inserts a page already costs, so it does not buy back
 * the lifetime the statements would need managing over.
 *
 * Issuing them against the connection rather than the transaction handle keeps them in the
 * transaction all the same: better-sqlite3 runs one connection, so every statement issued while
 * the transaction callback executes is part of that transaction whichever handle issued it. That
 * is the same property runRebuild's comment on peopleStore leans on, and the one
 * RebuildStateStore exists to stay out of the way of.
 */
export function withPage(
  sqlite: PageConnection, unit: PageUnit, collector: DropCollector, fn: () => void,
): boolean {
  sqlite.exec(`savepoint ${SAVEPOINT_NAME}`)
  try {
    fn()
  } catch (error) {
    // Before any recovery SQL: a fatal code means the disk or the connection is suspect, and a
    // `rollback to` issued against it can fail in turn, which would surface that secondary
    // failure in place of the real one. The outer transaction is about to be abandoned anyway.
    if (isFatalRebuildError(error)) throw error
    sqlite.exec(`rollback to savepoint ${SAVEPOINT_NAME}`)
    // ROLLBACK TO does not pop the savepoint - it only undoes the writes since it was taken and
    // leaves it on the stack so it could be rolled back to again. RELEASE is what pops it.
    //
    // Skipping this release does not fail the outer commit and does not change what ends up in
    // any table: SQLite silently releases every savepoint still open when the transaction that
    // contains it commits, so a rebuild that leaked one per drop would still commit cleanly with
    // exactly the right rows (checked directly - see with-page.test.ts). The actual cost is an
    // ever-growing savepoint stack, and the sub-journal SQLite pins per open savepoint to allow
    // rolling back to it, sitting open for the rest of the person's rebuild. On an archive with
    // thousands of bad pages that is thousands of pinned sub-journals never released until the
    // whole rebuild ends, not a correctness bug but a real resource cost this avoids.
    sqlite.exec(`release savepoint ${SAVEPOINT_NAME}`)
    collector.record(unit, error)
    return false
  }
  sqlite.exec(`release savepoint ${SAVEPOINT_NAME}`)
  collector.succeeded()
  return true
}
