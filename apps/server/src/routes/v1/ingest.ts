import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import {
  COMPANION_SOURCE, ConfigError, RawArchive, SampleKeys, TransientError, dataTypeById, localDateOf,
  mapSessions, mapWindowSamples, schema, supports,
} from '@haelan/core'
import type { DbOrTx, RouteRow, SampleRow, SegmentRow, SessionRow } from '@haelan/core'
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
 *
 * A page that maps to no rows is answered but not archived, and that is the one case where
 * this route writes nothing at all. See the guard below for why the window it would have
 * stored is worse than no row.
 */
export function registerIngestRoutes(app: FastifyInstance): void {
  app.post<{ Params: IngestParams, Body: IngestBody }>('/p/:personId/ingest/:dataTypeId', {
    bodyLimit: MAX_BODY_BYTES,
  }, async (request, reply) => {
    // The boot rebuild holds the write lock for its whole run (see ServerDeps.rebuildInFlight),
    // and this route writes on the request path with nothing else guarding it: an upload landing
    // mid rebuild would sit on the event loop until the lock clears and then fail anyway. Checked
    // first, before any parsing or mapping, so a phone gets a prompt answer instead of paying for
    // work this request cannot finish. TransientError renders as 503 (envelope.ts), which is the
    // one status SyncEngine.kt's isWorthRetrying treats as weather rather than a permanent
    // refusal - a 4xx here would read as "this data type is broken" and the phone would stop
    // syncing it forever.
    if (app.haelan.rebuildInFlight?.()) {
      throw new TransientError('a rebuild is in progress, try again shortly')
    }

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
    // Resolved once, here, so the id below is a cache hit off the same registry the mapping
    // step warms rather than a second write of its own. /companion/cursors reads this back out
    // of requestParams to key its cursor on (type, source) instead of type alone -- the fix for
    // a watch that syncs in late after the phone's own reading already moved a shared cursor.
    const resolvedSourceId = resolveSource()
    const mapped = dataType.target === 'samples'
      ? {
        samples: mapWindowSamples({
          dataType, personId, resolveSource,
          pages: [{ body: payload, rawPayloadId: 'pending' }],
        }),
        sessions: [] as SessionRow[],
        segments: [] as SegmentRow[],
        routes: [] as RouteRow[],
      }
      : (() => {
        const { sessions, segments, routes } = mapSessions({
          dataType, personId, resolveSource, body: payload, rawPayloadId: 'pending',
        })
        return { samples: [] as SampleRow[], sessions, segments, routes }
      })()

    // A page nobody could map anything out of is archived by nobody, and the check is first
    // because both scales of this route reach it: a page whose single point was unreadable, and
    // one carrying the maximum ten thousand where the mapper dropped every one of them.
    //
    // It is not an error - the phone sent what it had, and `dataPoints must not be empty` above
    // already refuses the case where it sent nothing at all - and it is not a write, since the
    // mapper drops a point it cannot read rather than inventing a zero for it (spec invariant 2).
    // What such a page does have is a window, and both halves of one are a claim about when
    // something happened. With no rows there is no such instant, and the only value left to
    // store is 0, which says 1970.
    //
    // That 1970 is not a wrong answer to an obscure question. `GET /companion/cursors` reports
    // the oldest window start it finds as `historyStartMs`, the web turns it into a local date
    // and clamps every card's range to it, so one such row pins a whole instance's history to
    // 1970-01-01 and the clamp stops doing the thing it exists for. It never heals, either: the
    // range only ever moves earlier, and the identical retry deduplicates onto this same row
    // instead of replacing it. So the row is not written, and the response says so: zero rows,
    // no payload id, and `applied` true because there is nothing pending.
    //
    // The cost is the other half of the same coin: nothing advances, so `lastWindowEndMs` for
    // this type stays where it was and the phone asks for the same window again next sync. A
    // window that maps to nothing today may map to something when a reading settles or a stage
    // is written into Health Connect, and a cursor that had moved past it would never look.
    if (mapped.samples.length === 0 && mapped.sessions.length === 0) {
      return reply.send({
        payloadId: null, deduplicated: false, rowsWritten: 0, affected: null, applied: true,
      })
    }

    // Both lists run over the same rows, and the two kinds put their instant in a different
    // column. The guard above is what lets these be unconditional: after it, `starts` cannot be
    // empty, so `Math.min` has something to answer and the fallback to 0 is gone with the row
    // that needed it.
    const starts = [
      ...mapped.samples.map((row) => row.utcMs),
      ...mapped.sessions.map((row) => row.startMs),
    ]
    const ends = [
      ...mapped.samples.map((row) => row.utcMs),
      ...mapped.sessions.map((row) => row.endMs),
    ]
    const windowStartMs = Math.min(...starts)
    const windowEndMs = Math.max(...ends) + 1

    const written = instance.db.transaction((tx) => {
      const archive = new RawArchive(tx)
      const { id, deduplicated } = archive.put({
        personId,
        dataType: dataType.id,
        requestParams: { source: COMPANION_SOURCE, dataType: dataType.id, dataSource: resolvedSourceId },
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
        : writeSessions(tx, mapped.sessions, mapped.segments, mapped.routes, id, localDates)
      for (const localDate of localDates) {
        instance.deriveQueue.markDirty({ personId, localDate, nowMs }, tx)
      }
      return { id, deduplicated, rowsWritten, localDates: [...localDates] }
    })

    // The sync runner only derives people connected to Google, so a companion-only person
    // would sit queued forever without this. Bounded and person scoped, the shared helper.
    //
    // One day per batch rather than the default eight, because a phone is holding a socket open
    // for this answer and its read timeout is 30 seconds. The budget is only checked BETWEEN
    // batches, so the batch size is how far past it a request can run: eight dense days of heart
    // rate outran that timeout on a first sync, and the phone abandoned a request this server then
    // completed successfully. No error was logged anywhere, the type read "never synced", and the
    // types queued behind it in the same run were never attempted.
    //
    // Whatever a single day does not finish stays queued, and drainLoop.ts takes it on its own
    // tick. This path only needs to leave `applied` meaningful for the ordinary case of an upload
    // covering one day, not to empty a thirty day backlog while a phone waits.
    drainPersonDerivation(app, personId, 'ingest', 1)
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
  // Prepared once for the whole upload rather than once per row - runJob.ts's identical statement
  // and the comment on it (#275). This connection is the server's own and lives for the process,
  // so a statement left per row is never reclaimed, and it is a phone's own upload, repeated,
  // that would grow it: worse here than the rebuild that first found the shape, because that
  // worker exited and took its statements with it.
  const insertSample = tx.insert(schema.samples).values({
    personRef: sql.placeholder('personRef'),
    sourceRef: sql.placeholder('sourceRef'),
    metricRef: sql.placeholder('metricRef'),
    utcMs: sql.placeholder('utcMs'),
    tzOffsetMinutes: sql.placeholder('tzOffsetMinutes'),
    aggRef: sql.placeholder('aggRef'),
    value: sql.placeholder('value'),
    n: sql.placeholder('n'),
    rawPayloadRef: sql.placeholder('rawPayloadRef'),
  } as unknown as typeof schema.samples.$inferInsert).onConflictDoUpdate({
    target: [schema.samples.personRef, schema.samples.sourceRef, schema.samples.metricRef, schema.samples.utcMs, schema.samples.aggRef],
    set: {
      value: sql.placeholder('value'),
      n: sql.placeholder('n'),
      tzOffsetMinutes: sql.placeholder('tzOffsetMinutes'),
      rawPayloadRef: sql.placeholder('rawPayloadRef'),
    } as unknown as Partial<typeof schema.samples.$inferInsert>,
  }).prepare()
  let rowsWritten = 0
  for (const row of samples) {
    const stored = keys.sampleRefs({ ...row, rawPayloadId })
    insertSample.run(stored)
    rowsWritten++
    localDates.add(localDateOf(row.utcMs, row.tzOffsetMinutes))
  }
  return rowsWritten
}

// The runJob writer for sessions, minus the paging: one upload is one page, and the
// segments and route of the sessions it names are replaced wholesale, because a re-upload
// after a night's stages settled, or a run's route finished writing to disk on the phone,
// legitimately changes the timeline and merging two versions of it would interleave them.
//
// Routes are written in this same transaction, beside sessions and segments, for the reason
// the call site above only opens one: a session whose route half landed and whose session
// row did not (or the other way round) is worse than a session with no route at all, and a
// transaction is what makes that impossible rather than merely unlikely.
function writeSessions(
  tx: DbOrTx,
  sessions: SessionRow[],
  segments: SegmentRow[],
  routes: RouteRow[],
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
    tx.delete(schema.sessionRoutes).where(eq(schema.sessionRoutes.sessionId, row.id)).run()
  }
  for (const segment of segments) tx.insert(schema.sessionSegments).values(segment).run()
  // Hoisted, where segments above are not, because drizzle prepares a statement on every .run()
  // and a route is the one thing here with an unbounded row count: a sleep night carries a
  // handful of stages, while an hour of GPS at 1Hz is about 3,600 points and one upload may
  // carry several workouts. Preparing per row retains kilobytes per row for the life of the
  // process (this connection is the server's, and unlike the rebuild worker it never exits),
  // which is the shape that caused the rebuild OOM. replay.ts hoists the same insert the same
  // way; these two writers are mirrors and a route written differently in one of them is the
  // drift that keeps producing defects here.
  //
  // No onConflictDoUpdate, exactly as in replay: the delete above replaces a session's route
  // wholesale, so every row this runs against is new.
  if (routes.length > 0) {
    const insertRoute = tx.insert(schema.sessionRoutes).values({
      id: sql.placeholder('id'),
      sessionId: sql.placeholder('sessionId'),
      ordinal: sql.placeholder('ordinal'),
      atMs: sql.placeholder('atMs'),
      latitude: sql.placeholder('latitude'),
      longitude: sql.placeholder('longitude'),
      altitudeMetres: sql.placeholder('altitudeMetres'),
      horizontalAccuracyMetres: sql.placeholder('horizontalAccuracyMetres'),
      verticalAccuracyMetres: sql.placeholder('verticalAccuracyMetres'),
    } as unknown as typeof schema.sessionRoutes.$inferInsert).prepare()
    for (const route of routes) insertRoute.run(route as unknown as typeof schema.sessionRoutes.$inferInsert)
  }
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
