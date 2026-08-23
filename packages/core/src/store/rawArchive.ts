import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { and, asc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { rawPayloads } from '../db/schema/index.ts'
import { ConfigError, TransientError } from '../errors.ts'

export interface PutInput {
  personId: string
  dataType: string
  requestParams: Record<string, unknown>
  windowStartMs: number
  windowEndMs: number
  fetchedAtMs: number
  httpStatus: number
  body: string
  /**
   * Which fetch call this page came from. One listDataPoints call passes the same value for
   * every page it paginates through; a caller that has no such notion leaves it out and the row
   * stores null, which is what every row archived before this existed looks like.
   */
  fetchEpisodeId?: string
}

export interface PutResult { id: string, deduplicated: boolean }

export interface ArchivedPayload {
  id: string
  dataType: string
  /** JSON, as stored. A rollup response carries `range`, a list response carries `filter`. */
  requestParams: string
  windowStartMs: number
  windowEndMs: number
  fetchedAtMs: number
  /** Null on any row archived before the column existed. See splitIntoEpisodes in replay.ts. */
  fetchEpisodeId: string | null
}

export class RawArchive {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  put(input: PutInput): PutResult {
    const bodyHash = createHash('sha256').update(input.body).digest('hex')
    const id = randomUUID()

    // Insert first and let the unique constraint decide, rather than select-then-insert: two
    // processes racing on the same new body (WAL mode lets the MCP server, the CLI and a sync
    // share the file) could both pass a prior select and then have the second insert throw. The
    // trailing re-fetch window means this path is hot, so a lost race must resolve to dedup, not
    // a crash.
    const result = this.#db.insert(rawPayloads).values({
      id,
      personId: input.personId,
      dataType: input.dataType,
      requestParams: JSON.stringify(input.requestParams),
      fetchEpisodeId: input.fetchEpisodeId ?? null,
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      fetchedAtMs: input.fetchedAtMs,
      httpStatus: input.httpStatus,
      bodyGzip: gzipSync(Buffer.from(input.body, 'utf8')),
      bodyHash,
      bodyBytes: Buffer.byteLength(input.body, 'utf8'),
    }).onConflictDoNothing({
      // fetchEpisodeId is deliberately absent from this target. Every episode has an id of its
      // own, so keying on it would end deduplication outright and archive the unchanged trailing
      // window again on every run. A conflicting body therefore keeps the episode that first
      // archived it, which is the right answer: the second call would have mapped the same
      // points to the same values, so the stored row already stands in for both.
      target: [
        rawPayloads.personId, rawPayloads.dataType, rawPayloads.bodyHash,
        rawPayloads.windowStartMs, rawPayloads.windowEndMs,
      ],
    }).run()

    if (result.changes > 0) return { id, deduplicated: false }

    const existing = this.#db.select({ id: rawPayloads.id }).from(rawPayloads).where(and(
      eq(rawPayloads.personId, input.personId),
      eq(rawPayloads.dataType, input.dataType),
      eq(rawPayloads.bodyHash, bodyHash),
      eq(rawPayloads.windowStartMs, input.windowStartMs),
      eq(rawPayloads.windowEndMs, input.windowEndMs),
    )).get()
    if (!existing) throw new TransientError('insert conflicted but no existing row found')
    return { id: existing.id, deduplicated: true }
  }

  /**
   * Every payload of one person's that a replay can map, oldest fetch first.
   *
   * Non-200 responses are excluded. The archive keeps them because a 429 body is evidence about
   * a sync, but there are no data points inside one to map.
   *
   * Ordered on fetch time rather than on window bounds, because fetch time is what the replay
   * actually needs: a later body must land after the one it corrects, and the only thing that
   * reliably says which came later is when each was fetched. Window bounds usually agree, which
   * is why they were the sort key first, but they are derived from the person's local day, so a
   * timezone that moves westward gives the same date earlier bounds than it had before. A window
   * first sort then puts the correction ahead of the reading it corrects and the replay lands the
   * stale one last.
   *
   * The id breaks a tie so two rows identical on fetch time still come back in a fixed order,
   * which is what lets a rebuild be deterministic.
   */
  listFor(personId: string): ArchivedPayload[] {
    return this.#db.select({
      id: rawPayloads.id,
      dataType: rawPayloads.dataType,
      requestParams: rawPayloads.requestParams,
      windowStartMs: rawPayloads.windowStartMs,
      windowEndMs: rawPayloads.windowEndMs,
      fetchedAtMs: rawPayloads.fetchedAtMs,
      fetchEpisodeId: rawPayloads.fetchEpisodeId,
    }).from(rawPayloads)
      .where(and(eq(rawPayloads.personId, personId), eq(rawPayloads.httpStatus, 200)))
      .orderBy(asc(rawPayloads.fetchedAtMs), asc(rawPayloads.id))
      .all()
  }

  // The person is part of the lookup rather than checked after it, so a caller cannot forget.
  // Every surface in section 11 reads through this, and there is no sharing mechanism in v1.
  getBody(personId: string, id: string): string {
    const row = this.#db.select({ bodyGzip: rawPayloads.bodyGzip }).from(rawPayloads)
      .where(and(eq(rawPayloads.id, id), eq(rawPayloads.personId, personId))).get()
    if (!row) throw new ConfigError(`raw payload ${id} not found for person ${personId}`)
    return gunzipSync(row.bodyGzip).toString('utf8')
  }
}
