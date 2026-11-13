import { and, between, eq, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import type { SampleKeys } from '../db/keys.ts'
import { companionDeletions, companionRecordSamples, samples, sessions } from '../db/schema/index.ts'
import type { SampleRow } from '../api/mapSamples.ts'
import { dataTypeById } from '../api/catalogue.ts'
import type { DataType } from '../api/catalogue.ts'
import { localDateOf } from '../derive/localDay.ts'

export interface DeletedRows { rowsDeleted: number, localDates: string[] }

// Under SQLite's 999 bound-parameter cap once the person and a few fixed values ride along.
const ID_CHUNK = 500

/**
 * Deleting what a companion record produced, and remembering that it was deleted.
 *
 * Links, not a samples column: `samples` holds millions of heart-rate rows and a text column there
 * would cost every one of them. A link is one row per (record, metric, source) with the utc range
 * the record produced, and a delete removes that source's rows of that metric inside the range.
 * Links are tier 2 and are rebuilt from the archive.
 *
 * Tombstones are tier 1. The archive still holds the payload a deleted record arrived in, so a
 * rebuild would bring it back; `reapplyDeletions` is what runs after replay to take it out again,
 * and `tombstoned` is what ingest asks so a late re-send cannot resurrect it. Deletions are not
 * archived in raw_payloads (plan Decisions): the cursors route reads every archive row as a window.
 */
export class CompanionRecords {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  /**
   * One link per (record, metric, source) of the rows that carry a recordId. A record arrives in
   * several uploads (a heart-rate record is chunked), so the stored range only ever widens.
   */
  link(personId: string, rows: readonly SampleRow[], keys: SampleKeys): void {
    const spans = new Map<string, {
      recordId: string, metricRef: number, sourceRef: number, first: number, last: number,
    }>()
    for (const row of rows) {
      if (row.recordId === undefined) continue
      const metricRef = keys.metricRef(row.metric)
      const sourceRef = keys.sourceRef(row.sourceId)
      const key = `${row.recordId}\u0000${metricRef}\u0000${sourceRef}`
      const span = spans.get(key)
      if (span) {
        span.first = Math.min(span.first, row.utcMs)
        span.last = Math.max(span.last, row.utcMs)
      } else {
        spans.set(key, { recordId: row.recordId, metricRef, sourceRef, first: row.utcMs, last: row.utcMs })
      }
    }
    if (spans.size === 0) return
    const personRef = keys.personRef(personId)
    const upsert = this.#db.insert(companionRecordSamples).values({
      personRef: sql.placeholder('personRef'),
      recordId: sql.placeholder('recordId'),
      sourceRef: sql.placeholder('sourceRef'),
      metricRef: sql.placeholder('metricRef'),
      firstUtcMs: sql.placeholder('first'),
      lastUtcMs: sql.placeholder('last'),
    } as unknown as typeof companionRecordSamples.$inferInsert).onConflictDoUpdate({
      target: [
        companionRecordSamples.personRef, companionRecordSamples.recordId,
        companionRecordSamples.metricRef, companionRecordSamples.sourceRef,
      ],
      set: {
        firstUtcMs: sql`min(${companionRecordSamples.firstUtcMs}, excluded.first_utc_ms)`,
        lastUtcMs: sql`max(${companionRecordSamples.lastUtcMs}, excluded.last_utc_ms)`,
      },
    }).prepare()
    for (const span of spans.values()) {
      upsert.run({
        personRef, recordId: span.recordId, sourceRef: span.sourceRef, metricRef: span.metricRef,
        first: span.first, last: span.last,
      })
    }
  }

  tombstoned(personId: string, recordIds: readonly string[]): Set<string> {
    const found = new Set<string>()
    for (let i = 0; i < recordIds.length; i += ID_CHUNK) {
      const rows = this.#db.select({ recordId: companionDeletions.recordId }).from(companionDeletions)
        .where(and(
          eq(companionDeletions.personId, personId),
          inArray(companionDeletions.recordId, recordIds.slice(i, i + ID_CHUNK)),
        )).all()
      for (const row of rows) found.add(row.recordId)
    }
    return found
  }

  deleteRecords(
    input: { personId: string, dataType: DataType, recordIds: readonly string[], nowMs: number },
    keys: SampleKeys,
  ): DeletedRows {
    const tombstone = this.#db.insert(companionDeletions).values({
      personId: input.personId,
      dataType: input.dataType.id,
      recordId: sql.placeholder('recordId'),
      deletedAtMs: input.nowMs,
    } as unknown as typeof companionDeletions.$inferInsert).onConflictDoNothing().prepare()
    for (const recordId of input.recordIds) tombstone.run({ recordId })
    return this.#remove(input.personId, input.dataType, input.recordIds, keys)
  }

  reapplyDeletions(personId: string, keys: SampleKeys): DeletedRows {
    const byType = new Map<string, string[]>()
    for (const row of this.#db.select().from(companionDeletions)
      .where(eq(companionDeletions.personId, personId)).all()) {
      const ids = byType.get(row.dataType)
      if (ids) ids.push(row.recordId)
      else byType.set(row.dataType, [row.recordId])
    }
    let rowsDeleted = 0
    const localDates = new Set<string>()
    for (const [dataTypeId, recordIds] of byType) {
      const dataType = dataTypeById(dataTypeId)
      if (!dataType) continue
      const removed = this.#remove(personId, dataType, recordIds, keys)
      rowsDeleted += removed.rowsDeleted
      for (const date of removed.localDates) localDates.add(date)
    }
    return { rowsDeleted, localDates: [...localDates].sort() }
  }

  #remove(personId: string, dataType: DataType, recordIds: readonly string[], keys: SampleKeys): DeletedRows {
    const dates = new Set<string>()
    let rowsDeleted = 0
    if (dataType.target === 'samples') {
      const personRef = keys.personRef(personId)
      const inRange = and(
        eq(samples.personRef, personRef),
        eq(samples.sourceRef, sql.placeholder('sourceRef')),
        eq(samples.metricRef, sql.placeholder('metricRef')),
        between(samples.utcMs, sql.placeholder('first'), sql.placeholder('last')),
      )
      const readRows = this.#db.select({ utcMs: samples.utcMs, offset: samples.tzOffsetMinutes })
        .from(samples).where(inRange).prepare()
      const deleteRows = this.#db.delete(samples).where(inRange).prepare()
      for (let i = 0; i < recordIds.length; i += ID_CHUNK) {
        const ids = recordIds.slice(i, i + ID_CHUNK)
        const linkWhere = and(
          eq(companionRecordSamples.personRef, personRef),
          inArray(companionRecordSamples.recordId, ids),
        )
        for (const link of this.#db.select().from(companionRecordSamples).where(linkWhere).all()) {
          const range = {
            sourceRef: link.sourceRef, metricRef: link.metricRef,
            first: link.firstUtcMs, last: link.lastUtcMs,
          }
          for (const row of readRows.all(range)) dates.add(localDateOf(row.utcMs, row.offset))
          rowsDeleted += deleteRows.run(range).changes
        }
        this.#db.delete(companionRecordSamples).where(linkWhere).run()
      }
    } else if (dataType.target === 'sessions') {
      for (let i = 0; i < recordIds.length; i += ID_CHUNK) {
        const where = and(
          eq(sessions.personId, personId),
          inArray(sessions.externalId, recordIds.slice(i, i + ID_CHUNK)),
        )
        for (const row of this.#db.select({ localDate: sessions.localDate }).from(sessions).where(where).all()) {
          dates.add(row.localDate)
        }
        // Segments and routes go by cascade (runRebuild.ts deletes sessions the same way).
        rowsDeleted += this.#db.delete(sessions).where(where).run().changes
      }
    }
    return { rowsDeleted, localDates: [...dates].sort() }
  }
}
