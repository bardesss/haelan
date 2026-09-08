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
