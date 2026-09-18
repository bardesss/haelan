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
    this.#db.transaction((tx) => {
      this.#assertOwned(tx, input.personId, input.sourceIds)
      this.#replace(tx, input.personId, input.metric)
      input.sourceIds.forEach((sourceId, rank) => {
        tx.insert(sourcePriority)
          .values({ personId: input.personId, metric: input.metric, sourceId, rank })
          .run()
      })
      this.#markContestedDays(input.personId, input.nowMs, tx)
    })
  }

  clear(input: { personId: string, metric: string, nowMs: number }): void {
    this.#db.transaction((tx) => {
      this.#replace(tx, input.personId, input.metric)
      this.#markContestedDays(input.personId, input.nowMs, tx)
    })
  }

  /**
   * The foreign key is on sources.id alone, so the database will happily file another household
   * member's source id under this person, where `lists` would read it straight back. Master
   * design section 15: an account sees only its own data, and a route can authorise the person
   * without knowing anything about the source ids in the body.
   */
  #assertOwned(tx: DbOrTx, personId: string, sourceIds: readonly string[]): void {
    for (const sourceId of sourceIds) {
      const owned = tx.select({ id: sources.id }).from(sources)
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
  // upsert would leave it behind at whatever rank it last held.
  #replace(tx: DbOrTx, personId: string, metric: string): void {
    tx.delete(sourcePriority).where(and(
      eq(sourcePriority.personId, personId),
      eq(sourcePriority.metric, metric),
    )).run()
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
   * Each contested day takes its neighbours with it. A night belongs to the morning it ended in
   * and sessionOverlap reads across midnight, so a contested day can move the day either side of
   * it. A spare day costs one empty derive; a missed day keeps a merge computed under the list
   * this write just replaced.
   */
  #markContestedDays(personId: string, nowMs: number, tx: DbOrTx): void {
    const personRef = new SampleKeys(tx).personRefIfKnown(personId)
    const contested = new Set<string>()

    if (personRef !== undefined) {
      // The local date is computed rather than stored, so it is computed here the same way
      // localDateOf does: shift the instant by its own offset, then take the calendar date.
      const rows = tx.all<{ localDate: string }>(sql`
        SELECT local_date AS localDate FROM (
          SELECT date((utc_ms + tz_offset_minutes * 60000) / 1000, 'unixepoch') AS local_date,
                 source_ref
          FROM samples
          WHERE person_ref = ${personRef}
          GROUP BY local_date, source_ref
        )
        GROUP BY local_date
        HAVING COUNT(*) > 1
      `)
      for (const row of rows) contested.add(row.localDate)
    }

    // Sessions carry their local date already, so this one needs no conversion.
    const sessionRows = tx.all<{ localDate: string }>(sql`
      SELECT local_date AS localDate FROM ${sessions}
      WHERE person_id = ${personId}
      GROUP BY local_date
      HAVING COUNT(DISTINCT source_id) > 1
    `)
    for (const row of sessionRows) contested.add(row.localDate)

    for (const localDate of contested) {
      for (const offset of [-1, 0, 1]) {
        this.#queue.markDirty(
          { personId, localDate: shiftLocalDate(localDate, offset), nowMs },
          tx,
        )
      }
    }
  }
}
