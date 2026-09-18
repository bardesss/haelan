import { and, asc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { samples, sessions, sourcePriority, sources } from '../db/schema/index.ts'
import { SampleKeys } from '../db/keys.ts'
import type { DeriveQueue } from './deriveQueue.ts'
import { ConfigError } from '../errors.ts'
import { priorityFrom } from '../derive/priority.ts'
import type { Priority, SourceFacts } from '../derive/priority.ts'
import { shiftLocalDate } from '../derive/localDay.ts'

export interface StoredList {
  metric: string
  sourceIds: string[]
}

/**
 * The per person, per metric ranking. Master design section 9's closing line: changing priority
 * is a rebuild, so every write here marks the person's days dirty rather than leaving yesterday's
 * merge standing under today's rule.
 */
export class SourcePriorityStore {
  readonly #db: DbOrTx

  readonly #queue: DeriveQueue

  constructor(db: DbOrTx, queue: DeriveQueue) {
    this.#db = db
    this.#queue = queue
  }

  load(personId: string): Priority {
    const lists = new Map<string, string[]>()
    for (const row of this.#rows(personId)) {
      const list = lists.get(row.metric)
      if (list) list.push(row.sourceId)
      else lists.set(row.metric, [row.sourceId])
    }

    const facts = this.#db.select({ id: sources.id, kind: sources.kind }).from(sources)
      .where(eq(sources.personId, personId)).all() as SourceFacts[]

    return priorityFrom({ lists, sources: facts })
  }

  lists(personId: string): StoredList[] {
    const out: StoredList[] = []
    for (const row of this.#rows(personId)) {
      const last = out.at(-1)
      if (last && last.metric === row.metric) last.sourceIds.push(row.sourceId)
      else out.push({ metric: row.metric, sourceIds: [row.sourceId] })
    }
    return out
  }

  put(input: { personId: string, metric: string, sourceIds: readonly string[], nowMs: number }): void {
    this.#assertOwned(input.personId, input.sourceIds)
    const contestedDates = this.#contestedDates(input.personId)
    this.#db.transaction((tx) => {
      this.#replace(tx, input.personId, input.metric)
      input.sourceIds.forEach((sourceId, rank) => {
        tx.insert(sourcePriority)
          .values({ personId: input.personId, metric: input.metric, sourceId, rank })
          .run()
      })
      this.#markDates(contestedDates, input.personId, input.nowMs, tx)
    })
  }

  /**
   * The delete runs before the contested-days scan, the opposite order from `put`, because a
   * clear can be a genuine no-op: a person who never configured a ranking still reaches this
   * route with `PUT { sourceIds: [] }`. `put` cannot take this shortcut, since it always inserts
   * something, but `clear` can check first and skip the multi-second scan and the marking it
   * feeds entirely when there was nothing stored to clear.
   */
  clear(input: { personId: string, metric: string, nowMs: number }): void {
    const deleted = this.#db.transaction((tx) => this.#replace(tx, input.personId, input.metric))
    if (deleted === 0) return
    const contestedDates = this.#contestedDates(input.personId)
    this.#db.transaction((tx) => {
      this.#markDates(contestedDates, input.personId, input.nowMs, tx)
    })
  }

  /**
   * The foreign key is on sources.id alone, so the database will happily file another household
   * member's source id under this person, where `lists` would read it straight back. Master
   * design section 15: an account sees only its own data, and a route can authorise the person
   * without knowing anything about the source ids in the body.
   *
   * Run against `#db` before `put` opens its transaction, and not repeated inside it. A source id
   * names the person it belongs to for as long as the row exists, so this is exactly as true
   * outside the transaction as inside one; asking twice would be duplication, not extra safety.
   * What this gives up is the one case where a named source row disappears between this check and
   * the insert below, and `source_priority.source_id`'s own foreign key is the backstop for that,
   * same as it always was. Checking first also means a request naming a source that is not this
   * person's fails on this cheap point read and never reaches `#contestedDates`, which is the
   * multi-second scan a malformed request must not get to pay for.
   */
  #assertOwned(personId: string, sourceIds: readonly string[]): void {
    for (const sourceId of sourceIds) {
      const owned = this.#db.select({ id: sources.id }).from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.personId, personId))).get()
      if (!owned) throw new ConfigError(`source ${sourceId} does not belong to this person`)
    }
  }

  #rows(personId: string) {
    return this.#db.select().from(sourcePriority)
      .where(eq(sourcePriority.personId, personId))
      .orderBy(asc(sourcePriority.metric), asc(sourcePriority.rank))
      .all()
  }

  // Delete then insert rather than upsert: a list that lost a source must lose its row, and an
  // upsert would leave it behind at whatever rank it last held. Returns the row count deleted, so
  // `clear` can tell a real clear from a no-op without a separate query.
  #replace(tx: DbOrTx, personId: string, metric: string): number {
    return tx.delete(sourcePriority).where(and(
      eq(sourcePriority.personId, personId),
      eq(sourcePriority.metric, metric),
    )).run().changes
  }

  /**
   * The days a ranking change could actually change, which is the days two or more sources
   * contributed rows to. `rank()` has three consumers (merge.ts, activityBands.ts,
   * sessionOverlap.ts) and all three use it only to choose between candidates competing for one
   * slot, so a day with a single source produces the same rows under any ranking. This replaced a
   * marker that marked every day between the person's first and last sample: correct, and on a
   * multi-year archive it queued more days than any drain converges through, so the change looked
   * like it did nothing for days.
   *
   * Not read off `daily.sourceMix`, which would be cheaper and wrong: mergeDay builds that from
   * hoursWon, so a source that had rows and won no hour does not appear in it, and those are
   * exactly the days a ranking change is most likely to flip.
   *
   * Run against `#db` rather than a transaction, and run before `put`/`clear` open theirs. The two
   * GROUP BYs each build a temp B-tree over the person's whole sample history, which on a real
   * archive is seconds, not the couple of indexed point reads the old marker cost. This project has
   * already shipped an outage from holding the write lock across a long operation on a request
   * path (1.16.0's boot rebuild), and a later task puts this call behind an HTTP PUT, so the scan
   * must finish before there is a lock to hold. The gap this opens is a sample landing between this
   * read and the write below leaving its own day unmarked; that is acceptable because both paths
   * that write samples, the sync runner's runJob and the companion ingest route, mark the day dirty
   * themselves and do not depend on this scan to catch it.
   *
   * Each contested day takes its neighbours with it. This is a margin, not a necessity:
   * deriveDayInto selects sessions and filters samples on an exact equality against the day's own
   * localDate, so nothing in a day's derivation actually reads a neighbouring day's rows. The
   * widening is here because a spare day costs one empty derive and a missed day keeps a merge
   * computed under the list this write just replaced, and between those two costs the cheap one
   * wins.
   */
  #contestedDates(personId: string): string[] {
    const personRef = new SampleKeys(this.#db).personRefIfKnown(personId)
    const contested = new Set<string>()

    if (personRef !== undefined) {
      // The local date is computed rather than stored, so it is computed here the same way
      // localDateOf does: shift the instant by its own offset, then take the calendar date.
      const rows = this.#db.all<{ localDate: string }>(sql`
        SELECT local_date AS localDate FROM (
          SELECT date((utc_ms + tz_offset_minutes * 60000) / 1000, 'unixepoch') AS local_date,
                 source_ref
          FROM ${samples}
          WHERE person_ref = ${personRef}
          GROUP BY local_date, source_ref
        )
        GROUP BY local_date
        HAVING COUNT(*) > 1
      `)
      for (const row of rows) contested.add(row.localDate)
    }

    // Sessions carry their local date already, so this one needs no conversion.
    const sessionRows = this.#db.all<{ localDate: string }>(sql`
      SELECT local_date AS localDate FROM ${sessions}
      WHERE person_id = ${personId}
      GROUP BY local_date
      HAVING COUNT(DISTINCT source_id) > 1
    `)
    for (const row of sessionRows) contested.add(row.localDate)

    const widened = new Set<string>()
    for (const localDate of contested) {
      for (const offset of [-1, 0, 1]) widened.add(shiftLocalDate(localDate, offset))
    }
    return [...widened]
  }

  // Split from #contestedDates so the scan above can run outside the write transaction while the
  // marking itself, which is cheap, still runs inside it alongside the rows it is a consequence of.
  #markDates(localDates: readonly string[], personId: string, nowMs: number, tx: DbOrTx): void {
    for (const localDate of localDates) {
      this.#queue.markDirty({ personId, localDate, nowMs }, tx)
    }
  }
}
