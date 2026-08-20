import { eq } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import type { DataType } from '../api/catalogue.ts'
import type { HealthClient } from '../api/client.ts'
import type { RawArchive } from '../store/rawArchive.ts'
import type { SourceRegistry } from '../store/sources.ts'
import type { SyncStateStore } from '../store/syncState.ts'
import { RevokedError } from '../api/tokens.ts'
import { HaelanError, TransientError } from '../errors.ts'
import { dayWindows } from './windows.ts'
import { mapWindowSamples } from '../api/mapSamples.ts'
import { mapSessions } from '../api/mapSessions.ts'
import { samples, sessions, sessionSegments } from '../db/schema/index.ts'

export interface JobDeps {
  db: Database
  archive: RawArchive
  sources: SourceRegistry
  syncState: SyncStateStore
  client: HealthClient
  now: () => number
}

export interface JobInput {
  personId: string
  dataType: DataType
  timezone: string
  fromMs: number
  toMs: number
  deps: JobDeps
}

export interface JobResult {
  windows: number
  points: number
  rowsWritten: number
  skipped: 'revoked' | 'unsupported' | null
}

export async function runJob(input: JobInput): Promise<JobResult> {
  const { deps, dataType: t } = input
  const empty: JobResult = { windows: 0, points: 0, rowsWritten: 0, skipped: null }
  if (!t.listSupported) return { ...empty, skipped: 'unsupported' }

  const windows = dayWindows({ fromMs: input.fromMs, toMs: input.toMs, timezone: input.timezone })
  let points = 0
  let rowsWritten = 0
  let highWaterMs = 0

  for (const window of windows) {
    try {
      const listed = await deps.client.listDataPoints({
        personId: input.personId, dataType: t, timezone: input.timezone,
        windowStartMs: window.startMs, windowEndMs: window.endMs,
      })
      points += listed.pointCount

      // One transaction per window, but the cursor is not part of it: recordSuccess runs once
      // after the whole loop, below, so a crash mid-loop commits this window's rows and leaves
      // the cursor behind rather than ahead. That is safe because the trailing re-fetch never
      // consults the cursor to decide what to fetch, so a lagging cursor only costs a re-fetch.
      rowsWritten += deps.db.transaction((tx) => {
        // Through tx, not the outer handle: the sources row a point resolves has to commit and
        // roll back with the rows whose foreign keys point at it.
        const resolveSource = (dataSource: unknown) =>
          deps.sources.resolve(input.personId, dataSource, deps.now(), tx)
        const pages = listed.payloadIds.map((id) => ({
          body: deps.archive.getBody(input.personId, id), rawPayloadId: id,
        }))
        return t.target === 'samples'
          ? writeSamples(tx, { dataType: t, personId: input.personId, resolveSource, pages })
          : writeSessions(tx, { dataType: t, personId: input.personId, resolveSource, pages })
      })

      highWaterMs = Math.max(highWaterMs, window.endMs)
    } catch (error) {
      // A rolled back window takes its sources rows with it, so the ids this person's cache
      // still holds may no longer exist. Every later write referencing one would fail the
      // foreign key, turning one bad window into a run of them.
      deps.sources.forget(input.personId)
      // A revoked person pauses alone. Every other failure stops this job and lets the rest of
      // the household keep syncing, because a failed sync must never block a dashboard read.
      if (error instanceof RevokedError) return { windows: windows.length, points, rowsWritten, skipped: 'revoked' }
      deps.syncState.recordFailure({
        personId: input.personId, dataType: t.id,
        error: classify(error),
        nowMs: deps.now(),
      })
      return { windows: windows.length, points, rowsWritten, skipped: null }
    }
  }

  if (highWaterMs > 0) {
    deps.syncState.recordSuccess({
      personId: input.personId, dataType: t.id, highWaterMs, nowMs: deps.now(),
    })
  }
  return { windows: windows.length, points, rowsWritten, skipped: null }
}

// last_error's first token is documented as the failure's class, so an unclassified throw from
// SQLite, zlib or a store still has to arrive with one. transient is the honest default: it is
// what the engine does with such a failure anyway, retrying the window on the next run, whereas
// schema_drift or data_quality would assert a diagnosis nobody has made.
function classify(error: unknown): HaelanError {
  if (error instanceof HaelanError) return error
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return new TransientError(message, { cause: error })
}

function writeSamples(tx: Parameters<Parameters<Database['transaction']>[0]>[0], args: {
  dataType: DataType, personId: string, resolveSource: (d: unknown) => string,
  pages: Array<{ body: string, rawPayloadId: string }>,
}): number {
  const rows = mapWindowSamples(args)
  for (const row of rows) {
    tx.insert(samples).values(row).onConflictDoUpdate({
      target: [samples.personId, samples.sourceId, samples.metric, samples.utcMs, samples.agg],
      set: { value: row.value, n: row.n, tzOffsetMinutes: row.tzOffsetMinutes, rawPayloadId: row.rawPayloadId },
    }).run()
  }
  return rows.length
}

function writeSessions(tx: Parameters<Parameters<Database['transaction']>[0]>[0], args: {
  dataType: DataType, personId: string, resolveSource: (d: unknown) => string,
  pages: Array<{ body: string, rawPayloadId: string }>,
}): number {
  let written = 0
  for (const page of args.pages) {
    const { sessions: rows, segments } = mapSessions({
      dataType: args.dataType, personId: args.personId, resolveSource: args.resolveSource,
      body: page.body, rawPayloadId: page.rawPayloadId,
    })
    for (const row of rows) {
      tx.insert(sessions).values(row).onConflictDoUpdate({
        target: [sessions.personId, sessions.sourceId, sessions.kind, sessions.externalId],
        set: { startMs: row.startMs, endMs: row.endMs, localDate: row.localDate, attrs: row.attrs },
      }).run()
      written++
    }
    // Segments are replaced wholesale for the sessions in this page: a re-fetch after Google
    // finishes processing a night legitimately changes the stage timeline, and merging two
    // versions of it would interleave them.
    for (const row of rows) tx.delete(sessionSegments).where(eq(sessionSegments.sessionId, row.id)).run()
    for (const segment of segments) tx.insert(sessionSegments).values(segment).run()
  }
  return written
}
