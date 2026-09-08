import { and, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { observations } from '../db/schema/index.ts'

export interface ObservationRow {
  id: string
  personId: string
  sourceId: string
  kind: string
  startedAtMs: number
  startedAtOffsetMinutes: number
  endedAtMs: number | null
  endedAtOffsetMinutes: number | null
  localDate: string
  value: string | null
  rawPayloadId: string | null
}

/**
 * Tier 2, not `events`. `events` is user-authored and survives every rebuild; an observation is
 * machine-written and a rebuild deletes and regenerates it, which is why `deleteForPerson` takes
 * a person rather than a row — it exists for exactly that rebuild path, not for a person to
 * remove one row they dislike.
 */
export class ObservationStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) {
    this.#db = db
  }

  // runJob re-fetches a trailing window on every sync, so the same point is re-mapped on the
  // next run and arrives here with the id it had before - mapObservations' stableId is derived
  // from the natural key, not random, for exactly this reason. A plain insert would throw a
  // UNIQUE violation on that repeat; upserting on id is what makes a re-fetch a no-op instead of
  // a failed window. id is also the whole target: the array index folded into it means a
  // reordered array (Google returning moods[] in a different order between fetches) swaps which
  // id gets which value rather than colliding two ids, so this upsert corrects the swapped row
  // in place rather than ever needing to delete one.
  writeMany(rows: readonly ObservationRow[]): void {
    for (const row of rows) {
      this.#db.insert(observations).values({
        id: row.id,
        personId: row.personId,
        sourceId: row.sourceId,
        kind: row.kind,
        startedAtMs: row.startedAtMs,
        startedAtOffsetMinutes: row.startedAtOffsetMinutes,
        endedAtMs: row.endedAtMs,
        endedAtOffsetMinutes: row.endedAtOffsetMinutes,
        localDate: row.localDate,
        value: row.value,
        rawPayloadId: row.rawPayloadId,
      }).onConflictDoUpdate({
        target: observations.id,
        set: {
          personId: row.personId,
          sourceId: row.sourceId,
          kind: row.kind,
          startedAtMs: row.startedAtMs,
          startedAtOffsetMinutes: row.startedAtOffsetMinutes,
          endedAtMs: row.endedAtMs,
          endedAtOffsetMinutes: row.endedAtOffsetMinutes,
          localDate: row.localDate,
          value: row.value,
          rawPayloadId: row.rawPayloadId,
        },
      }).run()
    }
  }

  listFor(personId: string, from: string, to: string): ObservationRow[] {
    return this.#db.select().from(observations).where(and(
      eq(observations.personId, personId),
      gte(observations.localDate, from),
      lte(observations.localDate, to),
    )).all().map((row) => ({
      id: row.id,
      personId: row.personId,
      sourceId: row.sourceId,
      kind: row.kind,
      startedAtMs: row.startedAtMs,
      startedAtOffsetMinutes: row.startedAtOffsetMinutes,
      endedAtMs: row.endedAtMs ?? null,
      endedAtOffsetMinutes: row.endedAtOffsetMinutes ?? null,
      localDate: row.localDate,
      value: row.value ?? null,
      rawPayloadId: row.rawPayloadId ?? null,
    }))
  }

  /** Deletes every observation a rebuild is about to regenerate. Returns the row count removed. */
  deleteForPerson(personId: string): number {
    return this.#db.delete(observations).where(eq(observations.personId, personId)).run().changes
  }
}
