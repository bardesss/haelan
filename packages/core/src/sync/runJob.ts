import { eq } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import type { DataType } from '../api/catalogue.ts'
import { supports } from '../api/catalogue.ts'
import type { HealthClient } from '../api/client.ts'
import type { RawArchive } from '../store/rawArchive.ts'
import type { SourceRegistry } from '../store/sources.ts'
import type { SyncStateStore } from '../store/syncState.ts'
import type { DeriveQueue } from '../store/deriveQueue.ts'
import { RevokedError } from '../api/tokens.ts'
import { HaelanError, TransientError } from '../errors.ts'
import { dayWindows } from './windows.ts'
import { mapWindowSamples } from '../api/mapSamples.ts'
import { mapSessions } from '../api/mapSessions.ts'
import { samples, sessions, sessionSegments } from '../db/schema/index.ts'

/**
 * Emitted as work completes. Nothing in core subscribes; the server's progress stream does,
 * and the backfill screen is the only reason a window level event exists at all.
 */
export type SyncProgress =
  | { kind: 'job_started', personId: string, dataType: string }
  | { kind: 'window_done', personId: string, dataType: string, localDate: string, rowsWritten: number }
  | { kind: 'job_finished', personId: string, dataType: string, rowsWritten: number, skipped: JobResult['skipped'] }
  | { kind: 'run_finished', jobs: number, rowsWritten: number, failed: number }

/** What runJob needs of a rate limiter. TokenBucket satisfies it. */
export interface RateLimiter {
  take(cost?: number): Promise<void>
}

export interface JobDeps {
  db: Database
  archive: RawArchive
  sources: SourceRegistry
  syncState: SyncStateStore
  client: HealthClient
  now: () => number
  /**
   * Optional, and unset by every caller today. dueJobs returns all twenty data types per
   * person, filtered on carrying any action rather than on being listable specifically; the
   * eighteen that support list still drive the request volume, roughly 720 for a trailing
   * week across a five person household, issued as fast as the event loop allows, against the
   * 300 per minute per user probe/findings/scopes.md measured. Choosing the rate is a settings
   * decision and belongs to M1d; the seat is here so filling it then is not a breaking change
   * to a published interface.
   */
  limiter?: RateLimiter
  /** Called as work completes. Optional: nothing in core needs it, the SSE stream does. */
  onProgress?: (event: SyncProgress) => void
  /**
   * Optional so the sync tests that predate derivation keep working. Set by openHaelan. A day
   * whose rows commit without being marked is a day the dashboard never sees.
   */
  deriveQueue?: DeriveQueue
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
  const report = (event: SyncProgress) => {
    // A subscriber that throws is a broken SSE client, not a reason to lose a window of data.
    try { deps.onProgress?.(event) } catch { /* ignore */ }
  }
  const finish = (result: JobResult): JobResult => {
    report({
      kind: 'job_finished', personId: input.personId, dataType: t.id,
      rowsWritten: result.rowsWritten, skipped: result.skipped,
    })
    return result
  }

  const empty: JobResult = { windows: 0, points: 0, rowsWritten: 0, skipped: null }
  if (!supports(t, 'list')) return { ...empty, skipped: 'unsupported' }

  report({ kind: 'job_started', personId: input.personId, dataType: t.id })

  const windows = dayWindows({ fromMs: input.fromMs, toMs: input.toMs, timezone: input.timezone })
  let points = 0
  let rowsWritten = 0
  let highWaterMs = 0

  for (const window of windows) {
    try {
      await deps.limiter?.take()
      const listed = await deps.client.listDataPoints({
        personId: input.personId, dataType: t, timezone: input.timezone,
        windowStartMs: window.startMs, windowEndMs: window.endMs,
      })
      points += listed.pointCount

      // Recorded here, at the point the fetch finished, rather than saved up for the end of the
      // job. last_error holds one string, and a failure recorded later in this same job has to
      // be the one that survives: a retry the client already recovered from must never be the
      // reason a real failure went unreported.
      if (listed.attempts > listed.pagesFetched) {
        deps.syncState.recordRetryEpisode({
          personId: input.personId, dataType: t.id,
          attempts: listed.attempts,
          // 0 when the retries were on the token endpoint, which answers with no status of its own.
          lastStatus: listed.lastRetriedStatus ?? 0,
          nowMs: deps.now(),
        })
      }

      // One transaction per window, but the cursor is not part of it: recordSuccess runs once
      // after the whole loop, below, so a crash mid-loop commits this window's rows and leaves
      // the cursor behind rather than ahead. That is the safe direction: runSync does consult the
      // mark to decide how far back to reach, and a lagging mark only ever costs a re-fetch of
      // days already held, where a leading one would skip days never fetched at all.
      const writtenHere = deps.db.transaction((tx) => {
        // Through tx, not the outer handle: the sources row a point resolves has to commit and
        // roll back with the rows whose foreign keys point at it.
        const resolveSource = (dataSource: unknown) =>
          deps.sources.resolve(input.personId, dataSource, deps.now(), tx)
        const pages = listed.payloadIds.map((id) => ({
          body: deps.archive.getBody(input.personId, id), rawPayloadId: id,
        }))
        const rows = t.target === 'samples'
          ? writeSamples(tx, { dataType: t, personId: input.personId, resolveSource, pages })
          : writeSessions(tx, { dataType: t, personId: input.personId, resolveSource, pages })
        // Through tx, so the mark commits and rolls back with the rows it describes. A day
        // marked for rows that were rolled back would derive from data that is not there.
        if (rows > 0) {
          deps.deriveQueue?.markDirty(
            { personId: input.personId, localDate: window.localDate, nowMs: deps.now() }, tx,
          )
        }
        return rows
      })
      rowsWritten += writtenHere
      report({
        kind: 'window_done', personId: input.personId, dataType: t.id,
        localDate: window.localDate, rowsWritten: writtenHere,
      })

      highWaterMs = Math.max(highWaterMs, window.endMs)
    } catch (error) {
      // A rolled back window takes its sources rows with it, so the ids this person's cache
      // still holds may no longer exist. Every later write referencing one would fail the
      // foreign key, turning one bad window into a run of them.
      deps.sources.forget(input.personId)
      // A revoked person pauses alone. Every other failure stops this job and lets the rest of
      // the household keep syncing, because a failed sync must never block a dashboard read.
      if (error instanceof RevokedError) return finish({ windows: windows.length, points, rowsWritten, skipped: 'revoked' })
      deps.syncState.recordFailure({
        personId: input.personId, dataType: t.id,
        error: classify(error),
        nowMs: deps.now(),
      })
      return finish({ windows: windows.length, points, rowsWritten, skipped: null })
    }
  }

  if (highWaterMs > 0) {
    const nowMs = deps.now()
    // Clamped, because today's window ends at the *next* local midnight and the mark would
    // otherwise sit up to a day ahead of now. A mark in the future is a claim to have synced
    // time that has not happened yet, and runSync's gap repair reads it as coverage: left
    // unclamped it would quietly subtract a day from what every run reaches back for.
    deps.syncState.recordSuccess({
      personId: input.personId, dataType: t.id, highWaterMs: Math.min(highWaterMs, nowMs), nowMs,
    })
  }
  // Nothing threw, so nothing else in this job will ever mention it: the pages were full, the
  // points parsed, and every one of them was skipped by a mapper that could not find its field.
  // Left unreported, a rename upstream reads exactly like a person who stopped wearing a device.
  // Types whose mapping is deferred are excluded, because writing no rows is their design.
  if (points > 0 && rowsWritten === 0 && !t.mappingDeferred) {
    deps.syncState.recordSchemaDrift({
      personId: input.personId, dataType: t.id, points, nowMs: deps.now(),
    })
  }

  return finish({ windows: windows.length, points, rowsWritten, skipped: null })
}

// last_error's first token is documented as the failure's class, so an unclassified throw from
// SQLite, zlib or a store still has to arrive with one. transient is the honest default: it is
// what the engine does with such a failure anyway, retrying the window on the next run, whereas
// schema_drift or data_quality would assert a diagnosis nobody has made.
// Exported so runRollupJob's caller in runSync classifies a rollup failure the same way rather
// than growing a second copy of the same judgment call.
export function classify(error: unknown): HaelanError {
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
      // Every field the mapper derives, not a subset: localDate is computed from the end offset,
      // so refreshing one without the other leaves a row whose local date and its own offset
      // disagree. rawPayloadId follows the correction for the same reason the sample upsert
      // refreshes it, so the row points at the payload it actually came from.
      tx.insert(sessions).values(row).onConflictDoUpdate({
        target: [sessions.personId, sessions.sourceId, sessions.kind, sessions.externalId],
        set: {
          startMs: row.startMs,
          startOffsetMinutes: row.startOffsetMinutes,
          endMs: row.endMs,
          endOffsetMinutes: row.endOffsetMinutes,
          localDate: row.localDate,
          attrs: row.attrs,
          rawPayloadId: row.rawPayloadId,
        },
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
