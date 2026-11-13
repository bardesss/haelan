import { and, between, eq, gte, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import type { SampleKeys } from '../db/keys.ts'
import { companionDeletions, companionRecordSamples, samples, sessions } from '../db/schema/index.ts'
import type { SampleRow } from '../api/mapSamples.ts'
import { dataTypeById } from '../api/catalogue.ts'
import type { DataType } from '../api/catalogue.ts'
import { sessionKindOf } from '../api/mapSessions.ts'
import { localDateOf } from '../derive/localDay.ts'

export interface DeletedRows { rowsDeleted: number, localDates: string[] }

// Under SQLite's 999 bound-parameter cap once the person and a few fixed values ride along.
const ID_CHUNK = 500

// Metrics whose one record is a series of readings: a heart-rate record is chunked across
// uploads, so its link has to widen to hold every chunk. Every other companion record is one
// reading, and an upload of it says where the whole record now is.
const SERIES_METRICS: ReadonlySet<string> = new Set(['heart_rate'])

/**
 * Deleting what a companion record produced, and remembering that it was deleted.
 *
 * Links, not a samples column: `samples` holds millions of heart-rate rows and a text column there
 * would cost every one of them. A link is one row per (record, metric, source) with the utc range
 * the record produced, and a delete removes that source's rows of that metric inside the range.
 * Links are tier 2 and are rebuilt from the archive.
 *
 * Tombstones are tier 1. The archive still holds the payload a deleted record arrived in, so a
 * rebuild would bring it back; `reapplyDeletions` is what runs after replay to take it out again.
 * A tombstone means "gone until it is written again": Health Connect gives a record written with
 * a clientRecordId the same id every time, so an app restoring a deleted entry re-sends that id,
 * and ingest `lift`s the tombstone instead of refusing the record. Deletions are not archived in
 * raw_payloads (plan Decisions): the cursors route reads every archive row as a window.
 */
export class CompanionRecords {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  /**
   * One link per (record, metric, source) of the rows that carry a recordId. A series record
   * arrives in several uploads (a heart-rate record is chunked), so its stored range only ever
   * widens. A one-reading record's upload replaces its range: a weight moved from Monday to
   * Friday at the source would otherwise cover Wednesday, and keep a deleted record's row there.
   *
   * The move also takes the record's old row with it, unless a live link of the same series
   * still covers it: nothing else ever would, and a later delete of the record only reaches
   * where it is now. Only when the old link is a single instant. A wider one of a one-reading
   * metric was widened before 2.24.0, and a row inside it may belong to a record with no link.
   * Replay runs the same deletes in the same order, so live and rebuild agree.
   */
  link(personId: string, rows: readonly SampleRow[], keys: SampleKeys): DeletedRows {
    const spans = new Map<string, {
      recordId: string, metric: string, metricRef: number, sourceRef: number, first: number, last: number,
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
        spans.set(key, { recordId: row.recordId, metric: row.metric, metricRef, sourceRef, first: row.utcMs, last: row.utcMs })
      }
    }
    if (spans.size === 0) return { rowsDeleted: 0, localDates: [] }
    const personRef = keys.personRef(personId)
    const upsert = (widen: boolean) => this.#db.insert(companionRecordSamples).values({
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
      set: widen
        ? {
            firstUtcMs: sql`min(${companionRecordSamples.firstUtcMs}, excluded.first_utc_ms)`,
            lastUtcMs: sql`max(${companionRecordSamples.lastUtcMs}, excluded.last_utc_ms)`,
          }
        : {
            firstUtcMs: sql`excluded.first_utc_ms`,
            lastUtcMs: sql`excluded.last_utc_ms`,
          },
    }).prepare()
    const widening = upsert(true)
    const replacing = upsert(false)
    const stored = this.#db.select({
      first: companionRecordSamples.firstUtcMs, last: companionRecordSamples.lastUtcMs,
    }).from(companionRecordSamples).where(and(
      eq(companionRecordSamples.personRef, personRef),
      eq(companionRecordSamples.recordId, sql.placeholder('recordId')),
      eq(companionRecordSamples.metricRef, sql.placeholder('metricRef')),
      eq(companionRecordSamples.sourceRef, sql.placeholder('sourceRef')),
    )).prepare()
    const left: { sourceRef: number, metricRef: number, at: number }[] = []
    for (const span of spans.values()) {
      const series = SERIES_METRICS.has(span.metric)
      const params = { recordId: span.recordId, sourceRef: span.sourceRef, metricRef: span.metricRef }
      if (!series) {
        const old = stored.get(params)
        if (old && old.first === old.last && (old.first < span.first || old.first > span.last)) {
          left.push({ sourceRef: span.sourceRef, metricRef: span.metricRef, at: old.first })
        }
      }
      const statement = series ? widening : replacing
      statement.run({ ...params, personRef, first: span.first, last: span.last })
    }
    // After every link of the upload is written: two records swapping instants in one upload
    // each cover the other's old row, and neither may take it.
    const dates = new Set<string>()
    let rowsDeleted = 0
    if (left.length > 0) {
      const remove = this.#uncoveredRemover(personId, personRef)
      for (const old of left) rowsDeleted += remove(old, old.at, old.at, dates)
    }
    return { rowsDeleted, localDates: [...dates].sort() }
  }

  /** Forgets the tombstones of records that were written again. */
  lift(personId: string, recordIds: readonly string[]): void {
    const unique = [...new Set(recordIds)]
    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      this.#db.delete(companionDeletions).where(and(
        eq(companionDeletions.personId, personId),
        inArray(companionDeletions.recordId, unique.slice(i, i + ID_CHUNK)),
      )).run()
    }
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
      const remove = this.#uncoveredRemover(personId, personRef)
      for (let i = 0; i < recordIds.length; i += ID_CHUNK) {
        const ids = recordIds.slice(i, i + ID_CHUNK)
        const linkWhere = and(
          eq(companionRecordSamples.personRef, personRef),
          inArray(companionRecordSamples.recordId, ids),
        )
        for (const link of this.#db.select().from(companionRecordSamples).where(linkWhere).all()) {
          rowsDeleted += remove(link, link.firstUtcMs, link.lastUtcMs, dates)
        }
        this.#db.delete(companionRecordSamples).where(linkWhere).run()
      }
    } else if (dataType.target === 'sessions') {
      for (let i = 0; i < recordIds.length; i += ID_CHUNK) {
        // Scoped to the type's own kind: an external id names a record of one type, and a
        // night and a workout that happened to share one must not take each other with them.
        const where = and(
          eq(sessions.personId, personId),
          eq(sessions.kind, sessionKindOf(dataType)),
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

  /**
   * Removes one series' rows inside [first, last] that no live link of the series covers, adds
   * their local dates to `dates` and answers how many went. Statements are prepared once per
   * returned function, so a caller makes one and runs it for every range.
   */
  #uncoveredRemover(personId: string, personRef: number) {
    // A row another record of the same source and metric also covers is kept, as long as that
    // record is not itself tombstoned: an app that re-writes an entry as delete A, insert B on
    // the same key would otherwise lose B to A's delete, live and again on every rebuild. A
    // record being deleted is tombstoned before this runs, so its own links never count, and a
    // record that moved has its link at the new range already. The live links are read once per deleted link and subtracted here rather than tested per row
    // in SQL: a correlated test per row scanned every link for every heart-rate minute.
    const inRange = and(
      eq(samples.personRef, personRef),
      eq(samples.sourceRef, sql.placeholder('sourceRef')),
      eq(samples.metricRef, sql.placeholder('metricRef')),
      between(samples.utcMs, sql.placeholder('first'), sql.placeholder('last')),
    )
    const readRows = this.#db.select({ utcMs: samples.utcMs, offset: samples.tzOffsetMinutes })
      .from(samples).where(inRange).prepare()
    const deleteRows = this.#db.delete(samples).where(inRange).prepare()
    // The longest link of a series bounds how early an overlapping link can start, so the
    // overlap read is a short range on companion_record_samples_series, not every earlier link.
    const longest = this.#db.select({
      span: sql<number | null>`max(${companionRecordSamples.lastUtcMs} - ${companionRecordSamples.firstUtcMs})`,
    }).from(companionRecordSamples).where(and(
      eq(companionRecordSamples.personRef, personRef),
      eq(companionRecordSamples.sourceRef, sql.placeholder('sourceRef')),
      eq(companionRecordSamples.metricRef, sql.placeholder('metricRef')),
    )).prepare()
    const covering = this.#db.select({
      first: companionRecordSamples.firstUtcMs, last: companionRecordSamples.lastUtcMs,
    }).from(companionRecordSamples).where(and(
      eq(companionRecordSamples.personRef, personRef),
      eq(companionRecordSamples.sourceRef, sql.placeholder('sourceRef')),
      eq(companionRecordSamples.metricRef, sql.placeholder('metricRef')),
      between(companionRecordSamples.firstUtcMs, sql.placeholder('from'), sql.placeholder('last')),
      gte(companionRecordSamples.lastUtcMs, sql.placeholder('first')),
      sql`not exists (select 1 from companion_deletions d
        where d.person_id = ${personId} and d.record_id = ${companionRecordSamples.recordId})`,
    )).prepare()
    const spans = new Map<string, number>()
    return (
      series: { sourceRef: number, metricRef: number }, first: number, last: number, dates: Set<string>,
    ): number => {
      const key = { sourceRef: series.sourceRef, metricRef: series.metricRef }
      const seriesKey = `${key.sourceRef}:${key.metricRef}`
      let span = spans.get(seriesKey)
      if (span === undefined) {
        span = longest.get(key)?.span ?? 0
        spans.set(seriesKey, span)
      }
      const live = covering.all({ ...key, from: first - span, first, last })
      let rowsDeleted = 0
      for (const part of uncovered(first, last, live)) {
        const range = { ...key, ...part }
        for (const row of readRows.all(range)) dates.add(localDateOf(row.utcMs, row.offset))
        rowsDeleted += deleteRows.run(range).changes
      }
      return rowsDeleted
    }
  }
}

/**
 * What is left of [first, last] once every covered range is taken out, as closed ranges. Sample
 * times are whole milliseconds, so a range ends one before a covered one starts.
 */
export function uncovered(
  first: number, last: number, covered: readonly { first: number, last: number }[],
): { first: number, last: number }[] {
  const parts: { first: number, last: number }[] = []
  let from = first
  for (const c of [...covered].sort((a, b) => a.first - b.first)) {
    if (from > last) break
    if (c.last < from) continue
    if (c.first > from) parts.push({ first: from, last: Math.min(c.first - 1, last) })
    from = Math.max(from, c.last + 1)
  }
  if (from <= last) parts.push({ first: from, last })
  return parts
}
