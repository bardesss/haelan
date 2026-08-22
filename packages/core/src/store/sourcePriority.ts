import { and, asc, desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { samples, sourcePriority, sources } from '../db/schema/index.ts'
import type { DeriveQueue } from './deriveQueue.ts'
import { priorityFrom } from '../derive/priority.ts'
import type { Priority, SourceFacts } from '../derive/priority.ts'
import { localDateOf } from '../derive/localDay.ts'

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
      this.#replace(tx, input.personId, input.metric)
      input.sourceIds.forEach((sourceId, rank) => {
        tx.insert(sourcePriority)
          .values({ personId: input.personId, metric: input.metric, sourceId, rank })
          .run()
      })
      this.#markEveryDay(input.personId, input.nowMs, tx)
    })
  }

  clear(input: { personId: string, metric: string, nowMs: number }): void {
    this.#db.transaction((tx) => {
      this.#replace(tx, input.personId, input.metric)
      this.#markEveryDay(input.personId, input.nowMs, tx)
    })
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
   * Every day between the person's first and last sample. Two indexed reads rather than a
   * distinct scan over millions of rows, and each end's offset is read off the boundary row
   * itself, so somebody who moved timezone still gets both ends of their history right.
   */
  #markEveryDay(personId: string, nowMs: number, tx: DbOrTx): void {
    const columns = { utcMs: samples.utcMs, tzOffsetMinutes: samples.tzOffsetMinutes }
    const first = tx.select(columns).from(samples).where(eq(samples.personId, personId))
      .orderBy(asc(samples.utcMs)).limit(1).get()
    const last = tx.select(columns).from(samples).where(eq(samples.personId, personId))
      .orderBy(desc(samples.utcMs)).limit(1).get()
    if (!first || !last) return

    this.#queue.markRange({
      personId,
      fromLocalDate: localDateOf(first.utcMs, first.tzOffsetMinutes),
      toLocalDate: localDateOf(last.utcMs, last.tzOffsetMinutes),
      nowMs,
    })
  }
}
