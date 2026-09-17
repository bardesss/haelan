import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import {
  ConfigError, RawArchive, SampleKeys, dataTypeById, localDateOf,
  mapSessions, mapWindowSamples, schema, supports,
} from '@haelan/core'
import type { DbOrTx, SampleRow, SegmentRow, SessionRow } from '@haelan/core'
import { drainPersonDerivation } from './annotations.ts'

interface PersonParams { personId: string }
interface IngestParams extends PersonParams { dataTypeId: string }

interface IngestBody {
  dataPoints?: unknown
  dataSource?: unknown
}

// One dense day of heart rate is tens of thousands of points at full resolution, but the
// mapper downsamples to the minute before anything is written, and a request carrying more
// than this is a client bug rather than a day worth holding the event loop for.
const MAX_POINTS = 10_000

// The body that carries MAX_POINTS, with room to spare. Fastify's own default is one mebibyte,
// which is smaller than a legitimate request: a thousand heart rate samples are a couple of
// hundred kilobytes and ten thousand of them are megabytes, so the default would answer 413 to
// a body this route's own contract calls valid. Sessions are worse, since one night carries all
// of its stages. Thirty-two mebibytes holds any accepted request and still bounds the read.
const MAX_BODY_BYTES = 32 * 1024 * 1024

// The identity companion uploads resolve to when they name none of their own. Shaped like
// a Google dataSource so describe() files it as one stable source: platform plus package
// name, kind app. A reading somebody typed in by hand stays manual by naming
// recordingMethod MANUAL in its own dataSource instead.
const DEFAULT_DATA_SOURCE = {
  platform: 'HEALTH_CONNECT',
  application: { packageName: 'com.haelan.android' },
  recordingMethod: 'PASSIVELY_MEASURED',
}

/**
 * The companion app's way in: Health Connect readings, already shaped as a Google v4 list
 * body, archived and mapped through the same path a sync window takes.
 *
 * Samples and sessions. Observations have no writer yet, and a type fanning out to several
 * tables (electrocardiogram) would silently drop the tables no writer ran for while
 * answering 200, so both are refused with the reason rather than half written.
 */
export function registerIngestRoutes(app: FastifyInstance): void {
  app.post<{ Params: IngestParams, Body: IngestBody }>('/p/:personId/ingest/:dataTypeId', {
    bodyLimit: MAX_BODY_BYTES,
  }, async (request, reply) => {
    const personId = personIdOf(request)
    const dataType = dataTypeById(request.params.dataTypeId)
    if (!dataType) throw new ConfigError(`unknown data type '${request.params.dataTypeId}'`)
    if (!supports(dataType, 'list') || dataType.mappingDeferred
      || (dataType.target !== 'samples' && dataType.target !== 'sessions')
      || (dataType.alsoTargets?.length ?? 0) > 0) {
      throw new ConfigError(`'${dataType.id}' cannot be ingested by the companion app yet`)
    }

    const body = request.body ?? {}
    if (!Array.isArray(body.dataPoints)) throw new ConfigError('dataPoints must be an array')
    if (body.dataPoints.length === 0) throw new ConfigError('dataPoints must not be empty')
    if (body.dataPoints.length > MAX_POINTS) {
      throw new ConfigError(`dataPoints carries ${body.dataPoints.length} points, more than the ${MAX_POINTS} maximum`)
    }
    const dataSource = body.dataSource === undefined ? DEFAULT_DATA_SOURCE : body.dataSource
    if (typeof dataSource !== 'object' || dataSource === null || Array.isArray(dataSource)) {
      throw new ConfigError('dataSource must be an object')
    }

    // The archived body carries the request's own dataSource beside its points, and that is the
    // identity every row below is written under. The archive is the only thing a rebuild can
    // read, so a body holding the points alone would replay under `unknown` forever; the points
    // themselves carry no source, since a point's own is deliberately not read here.
    const payload = JSON.stringify({ dataPoints: body.dataPoints, dataSource })
    const nowMs = app.haelan.now()
    const instance = app.haelan.instance
    const sources = app.haelan.stores.sources

    // Mapped once, outside the transaction: the rows are pure data, and the source row the
    // mapping resolves already exists by the time the transaction opens, so its own resolve
    // is a cache hit rather than a second write. A rollback then takes rows and marks with
    // it while the source registry keeps the companion phone, which the retry reuses.
    //
    // The request's dataSource is authoritative for every row, and a point's own dataSource
    // is deliberately not read: the phone uploading is the source, and per-point identities
    // inside a companion payload describe where the phone read the value rather than a
    // source this instance could ever choose between. The archived body keeps them verbatim.
    const resolveSource = () => sources.resolve(personId, dataSource, nowMs)
    const mapped = dataType.target === 'samples'
      ? {
        samples: mapWindowSamples({
          dataType, personId, resolveSource,
          pages: [{ body: payload, rawPayloadId: 'pending' }],
        }),
        sessions: [] as SessionRow[],
        segments: [] as SegmentRow[],
      }
      : (() => {
        const { sessions, segments } = mapSessions({
          dataType, personId, resolveSource, body: payload, rawPayloadId: 'pending',
        })
        return { samples: [] as SampleRow[], sessions, segments }
      })()

    const starts = [
      ...mapped.samples.map((row) => row.utcMs),
      ...mapped.sessions.map((row) => row.startMs),
    ]
    const ends = [
      ...mapped.samples.map((row) => row.utcMs),
      ...mapped.sessions.map((row) => row.endMs),
    ]
    const windowStartMs = starts.length > 0 ? Math.min(...starts) : 0
    const windowEndMs = ends.length > 0 ? Math.max(...ends) + 1 : 0

    const written = instance.db.transaction((tx) => {
      const archive = new RawArchive(tx)
      const { id, deduplicated } = archive.put({
        personId,
        dataType: dataType.id,
        requestParams: { source: 'companion', dataType: dataType.id },
        fetchEpisodeId: randomUUID(),
        windowStartMs,
        windowEndMs,
        fetchedAtMs: nowMs,
        httpStatus: 200,
        body: payload,
      })
      const localDates = new Set<string>()
      const rowsWritten = dataType.target === 'samples'
        ? writeSamples(tx, mapped.samples, id, localDates)
        : writeSessions(tx, mapped.sessions, mapped.segments, id, localDates)
      for (const localDate of localDates) {
        instance.deriveQueue.markDirty({ personId, localDate, nowMs }, tx)
      }
      return { id, deduplicated, rowsWritten, localDates: [...localDates] }
    })

    // The sync runner only derives people connected to Google, so a companion-only person
    // would sit queued forever without this. Bounded and person scoped, the shared helper.
    drainPersonDerivation(app, personId, 'ingest')
    const applied = !written.localDates.some((localDate) => stillQueued(app, personId, localDate))
    const ordered = [...written.localDates].sort()
    return reply.send({
      payloadId: written.id,
      deduplicated: written.deduplicated,
      rowsWritten: written.rowsWritten,
      affected: ordered.length > 0
        ? { from: ordered[0], to: ordered[ordered.length - 1] }
        : null,
      applied,
    })
  })
}

// Translated here rather than in the mapper, the same line runJob draws: the mapper reads
// a provider's JSON and has no database to ask.
function writeSamples(
  tx: DbOrTx,
  samples: SampleRow[],
  rawPayloadId: string,
  localDates: Set<string>,
): number {
  // One per transaction, never hoisted: the same staleness runJob's own comment names,
  // a rolled back window leaving refs behind that the next write would trip over.
  const keys = new SampleKeys(tx)
  let rowsWritten = 0
  for (const row of samples) {
    const stored = keys.sampleRefs({ ...row, rawPayloadId })
    tx.insert(schema.samples).values(stored).onConflictDoUpdate({
      target: [schema.samples.personRef, schema.samples.sourceRef, schema.samples.metricRef, schema.samples.utcMs, schema.samples.aggRef],
      set: {
        value: stored.value,
        n: stored.n,
        tzOffsetMinutes: stored.tzOffsetMinutes,
        rawPayloadRef: stored.rawPayloadRef,
      },
    }).run()
    rowsWritten++
    localDates.add(localDateOf(row.utcMs, row.tzOffsetMinutes))
  }
  return rowsWritten
}

// The runJob writer for sessions, minus the paging: one upload is one page, and the
// segments of the sessions it names are replaced wholesale, because a re-upload after a
// night's stages settled legitimately changes the timeline and merging two versions of
// it would interleave them.
function writeSessions(
  tx: DbOrTx,
  sessions: SessionRow[],
  segments: SegmentRow[],
  rawPayloadId: string,
  localDates: Set<string>,
): number {
  let rowsWritten = 0
  for (const row of sessions) {
    // A session that moved days leaves derived rows behind on the day it left. localDate is
    // in the set clause below, so a revised end time across midnight legitimately moves one,
    // and the day it left is only rewritten if the queue is told it is dirty.
    const previous = tx.select({ localDate: schema.sessions.localDate })
      .from(schema.sessions).where(eq(schema.sessions.id, row.id)).get()
    if (previous && previous.localDate !== row.localDate) localDates.add(previous.localDate)
    tx.insert(schema.sessions).values({ ...row, rawPayloadId }).onConflictDoUpdate({
      target: [schema.sessions.personId, schema.sessions.sourceId, schema.sessions.kind, schema.sessions.externalId],
      set: {
        startMs: row.startMs,
        startOffsetMinutes: row.startOffsetMinutes,
        endMs: row.endMs,
        endOffsetMinutes: row.endOffsetMinutes,
        localDate: row.localDate,
        attrs: row.attrs,
        rawPayloadId,
      },
    }).run()
    rowsWritten++
    localDates.add(row.localDate)
  }
  for (const row of sessions) {
    tx.delete(schema.sessionSegments).where(eq(schema.sessionSegments.sessionId, row.id)).run()
  }
  for (const segment of segments) tx.insert(schema.sessionSegments).values(segment).run()
  return rowsWritten
}

/**
 * registerV1's plugin wide guard has already refused this request unless :personId is the
 * signed in account's own person. Read here rather than off personQuery, the way the
 * annotation routes do.
 */
function personIdOf(request: FastifyRequest<{ Params: PersonParams }>): string {
  return request.params.personId
}

/** A queue that cannot be read answers "still queued", so an unknown state is never called applied. */
function stillQueued(app: FastifyInstance, personId: string, localDate: string): boolean {
  try {
    return app.haelan.instance.deriveQueue.has({ personId, localDate })
  } catch (error) {
    console.error(`ingest: could not read the derive queue for ${personId}, ${error instanceof Error ? error.message : String(error)}`)
    return true
  }
}
