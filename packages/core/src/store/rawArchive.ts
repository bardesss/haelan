import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import { rawPayloads } from '../db/schema/index.ts'

export interface PutInput {
  personId: string
  dataType: string
  requestParams: Record<string, unknown>
  windowStartMs: number
  windowEndMs: number
  fetchedAtMs: number
  httpStatus: number
  body: string
}

export interface PutResult { id: string, deduplicated: boolean }

export class RawArchive {
  constructor(private readonly db: Database) {}

  put(input: PutInput): PutResult {
    const bodyHash = createHash('sha256').update(input.body).digest('hex')
    const id = randomUUID()

    // Insert first and let the unique constraint decide, rather than select-then-insert: two
    // processes racing on the same new body (WAL mode lets the MCP server, the CLI and a sync
    // share the file) could both pass a prior select and then have the second insert throw. The
    // trailing re-fetch window means this path is hot, so a lost race must resolve to dedup, not
    // a crash.
    const result = this.db.insert(rawPayloads).values({
      id,
      personId: input.personId,
      dataType: input.dataType,
      requestParams: JSON.stringify(input.requestParams),
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      fetchedAtMs: input.fetchedAtMs,
      httpStatus: input.httpStatus,
      bodyGzip: gzipSync(Buffer.from(input.body, 'utf8')),
      bodyHash,
      bodyBytes: Buffer.byteLength(input.body, 'utf8'),
    }).onConflictDoNothing({
      target: [rawPayloads.personId, rawPayloads.dataType, rawPayloads.bodyHash, rawPayloads.windowStartMs],
    }).run()

    if (result.changes > 0) return { id, deduplicated: false }

    const existing = this.db.select({ id: rawPayloads.id }).from(rawPayloads).where(and(
      eq(rawPayloads.personId, input.personId),
      eq(rawPayloads.dataType, input.dataType),
      eq(rawPayloads.bodyHash, bodyHash),
      eq(rawPayloads.windowStartMs, input.windowStartMs),
    )).get()
    if (!existing) throw new Error('insert conflicted but no existing row found')
    return { id: existing.id, deduplicated: true }
  }

  // The person is part of the lookup rather than checked after it, so a caller cannot forget.
  // Every surface in section 11 reads through this, and there is no sharing mechanism in v1.
  getBody(personId: string, id: string): string {
    const row = this.db.select({ bodyGzip: rawPayloads.bodyGzip }).from(rawPayloads)
      .where(and(eq(rawPayloads.id, id), eq(rawPayloads.personId, personId))).get()
    if (!row) throw new Error(`raw payload ${id} not found for person ${personId}`)
    return gunzipSync(row.bodyGzip).toString('utf8')
  }
}
