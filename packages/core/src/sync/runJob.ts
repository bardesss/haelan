import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import type { DataType } from '../api/catalogue.ts'
import { supports } from '../api/catalogue.ts'
import type { HealthClient } from '../api/client.ts'
import type { RawArchive } from '../store/rawArchive.ts'
import type { SourceRegistry } from '../store/sources.ts'
import type { SyncStateStore } from '../store/syncState.ts'
import type { DeriveQueue } from '../store/deriveQueue.ts'
import { RevokedError } from '../api/tokens.ts'
import { AuthError, CredentialsUnreadableError, HaelanError, RateLimitedError, TransientError } from '../errors.ts'
import { dayWindows } from './windows.ts'
import { mapWindowSamples } from '../api/mapSamples.ts'
import { sampleDirtyDates } from './dirtyDates.ts'
import { sleepNeighbourDates } from '../derive/sleep.ts'
import { mapSessions } from '../api/mapSessions.ts'
import { mapObservations } from '../api/mapObservations.ts'
import { ObservationStore } from '../store/observations.ts'
import { samples, sessions, sessionSegments } from '../db/schema/index.ts'
import { SampleKeys } from '../db/keys.ts'

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
  /**
   * Count a failing window toward giving up on it. runSync passes true, so every sync run counts,
   * the scheduled one and a manual one alike; a backfill revisiting a day does not, because it
   * is not another trailing run. A failure raised as transient (HTTP 429/5xx, the network) or as
   * an AuthError does not count: an outage or a refused token must never be able to skip a window,
   * since skipping lets the mark jump over days nothing ever read. Nor does any failure in a run
   * where no window of the job succeeded, since every day failing at once is the type or the
   * person failing (a missing scope, a dead client), not one bad day.
   */
  trackWindowFailures?: boolean
}

export interface JobResult {
  windows: number
  points: number
  /** Windows whose body was not a shape this code knows. Non-zero withholds the mark. */
  unreadableWindows: number
  /** Windows whose fetch or write threw in this call. */
  failedWindows: number
  /** The subset of failedWindows whose window is skipped: recorded as such now, or already was. */
  skippedWindows: number
  /** The client gave up on a 429, so the job stopped early. The caller should stop asking this person. */
  rateLimited: boolean
  rowsWritten: number
  skipped: 'revoked' | 'credentials_unreadable' | 'unsupported' | null
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

  const empty: JobResult = { windows: 0, points: 0, rowsWritten: 0, unreadableWindows: 0, failedWindows: 0, skippedWindows: 0, rateLimited: false, skipped: null }
  if (!supports(t, 'list')) return { ...empty, skipped: 'unsupported' }

  report({ kind: 'job_started', personId: input.personId, dataType: t.id })

  const windows = dayWindows({ fromMs: input.fromMs, toMs: input.toMs, timezone: input.timezone })
  let points = 0
  let unreadableWindows = 0
  let rowsWritten = 0
  // One entry per window attempted, in order. The mark may move to the end of the last window
  // before the first one still failing: the windows after a failing one are fetched and written,
  // but a mark past it would claim the failing day was read. 'pending' is a failure that may count
  // toward the skip, settled after the loop because only then is it known whether any window of
  // this job succeeded.
  const outcomes: Array<{ endMs: number, state: 'ok' | 'skipped' | 'failed' | 'pending', error?: unknown }> = []
  const pending: Array<{ index: number, window: typeof windows[number], error: unknown }> = []
  let failedWindows = 0
  let rateLimited = false

  for (const window of windows) {
    try {
      const listed = await deps.client.listDataPoints({
        personId: input.personId, dataType: t, timezone: input.timezone,
        windowStartMs: window.startMs, windowEndMs: window.endMs,
      })
      points += listed.pointCount
      unreadableWindows += listed.unreadablePages

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
        // One per transaction, and never hoisted out of this callback. Its caches answer from
        // memory, so an instance that outlived a rolled back window would keep handing out refs
        // for rows that went with it; the foreign keys on `samples` would then reject the next
        // write rather than let it land, but the window it rejected would be a good one.
        const keys = new SampleKeys(tx)
        const writeFor = (target: DataType['target']) =>
          target === 'samples'
            ? writeSamples(tx, { dataType: t, personId: input.personId, resolveSource, pages, keys })
            : target === 'sessions'
            ? writeSessions(tx, { dataType: t, personId: input.personId, resolveSource, pages })
            : writeObservations(tx, { dataType: t, personId: input.personId, resolveSource, pages })
        // ECG (and any future type like it) names one primary target plus alsoTargets, and one
        // fetched page has to become a row in each: the primary writer alone is what left the
        // samples and observations rows unwritten before this loop existed. Every writer's own
        // guard already reads alsoTargets to accept a foreign-looking dataType (mapSamples.ts,
        // mapSessions.ts, mapObservations.ts), so running one writer per named target is the
        // other half of that contract.
        const writes = [writeFor(t.target), ...(t.alsoTargets ?? []).map(writeFor)]
        const rowsWrittenHere = writes.reduce((sum, w) => sum + w.rows, 0)
        // Merged across every writer, not just the primary one: the derive queue is marked from
        // this set, and a local date only the samples or observations writer touched - never the
        // primary sessions writer - would otherwise never be marked dirty, leaving its derived
        // values stale forever.
        const localDates = new Set(writes.flatMap((w) => w.localDates))
        // The days the rows themselves fall on, not the day this window asked for. A window is
        // computed in the person's current timezone, while runDerive selects a day's rows by
        // each row's own offset, so a sample from a trip abroad can arrive in window D and
        // belong to local date D-1. Marking D would leave D-1 unmarked and its stale value
        // uncorrected by any later run. Through tx, so a mark commits and rolls back with the
        // rows it describes: a day marked for rows that rolled back would derive from data that
        // is not there.
        for (const localDate of localDates) {
          deps.deriveQueue?.markDirty(
            { personId: input.personId, localDate, nowMs: deps.now() }, tx,
          )
        }
        return rowsWrittenHere
      })
      rowsWritten += writtenHere
      report({
        kind: 'window_done', personId: input.personId, dataType: t.id,
        localDate: window.localDate, rowsWritten: writtenHere,
      })

      // Guarded: the window is committed by now, and a store that cannot forget its failure
      // must not turn it into one.
      try {
        deps.syncState.clearWindowFailure(input.personId, t.id, window.startMs)
      } catch (clearError) {
        console.error(`sync: could not clear window failure for ${t.id} (${classify(clearError).message})`)
      }
      outcomes.push({ endMs: window.endMs, state: 'ok' })
    } catch (error) {
      // A rolled back window takes its sources rows with it, so the ids this person's cache
      // still holds may no longer exist. Every later write referencing one would fail the
      // foreign key, turning one bad window into a run of them.
      deps.sources.forget(input.personId)
      // A revoked person pauses alone. Every other failure stops this job and lets the rest of
      // the household keep syncing, because a failed sync must never block a dashboard read.
      if (error instanceof RevokedError) return finish({ windows: windows.length, points, rowsWritten, unreadableWindows, failedWindows: 0, skippedWindows: 0, rateLimited: false, skipped: 'revoked' })
      // Same treatment, for the same reason: a key that cannot open this person's token is not
      // this window failing, or this type, or this run - it is every window for this person
      // until they reconsent, and recording it as a failure would write that story to every
      // data type, every day, for a state that already has its own name.
      if (error instanceof CredentialsUnreadableError) {
        return finish({ windows: windows.length, points, rowsWritten, unreadableWindows, failedWindows: 0, skippedWindows: 0, rateLimited: false, skipped: 'credentials_unreadable' })
      }
      failedWindows++
      // The client already spent its attempts on this window, and the next one would meet the
      // same quota. Not recorded against the window, since the window did nothing wrong, and the
      // loop ends so the rest of the days are not each given five more requests.
      if (error instanceof RateLimitedError) {
        rateLimited = true
        outcomes.push({ endMs: window.endMs, state: 'failed', error })
        break
      }
      let alreadySkipped = false
      try {
        alreadySkipped = deps.syncState.isWindowSkipped(input.personId, t.id, window.startMs)
      } catch (storeError) {
        // Treated as not skipped, so the window keeps blocking: the safe direction for the mark.
        console.error(`sync: could not read window skip for ${t.id} (${classify(storeError).message})`)
      }
      const counts = input.trackWindowFailures === true
        && !(error instanceof TransientError) && !(error instanceof AuthError)
      // Counted even when already skipped, so its record keeps the latest error.
      if (counts) pending.push({ index: outcomes.length, window, error })
      outcomes.push({ endMs: window.endMs, state: alreadySkipped ? 'skipped' : counts ? 'pending' : 'failed', error })
    }
  }

  // A window that reaches the threshold here is skipped in this same run, so the poison day stops
  // holding the mark on the run that gives up on it rather than one run later.
  const anySucceeded = outcomes.some((o) => o.state === 'ok')
  for (const { index, window, error } of pending) {
    const outcome = outcomes[index]!
    if (!anySucceeded) {
      if (outcome.state === 'pending') outcome.state = 'failed'
      continue
    }
    let skipped = false
    try {
      skipped = deps.syncState.recordWindowFailure({
        personId: input.personId, dataType: t.id,
        window: { startMs: window.startMs, endMs: window.endMs, localDate: window.localDate },
        error: classify(error), nowMs: deps.now(),
      }).skipped
    } catch (storeError) {
      console.error(`sync: could not record window failure for ${t.id} (${classify(storeError).message})`)
    }
    if (outcome.state === 'pending') outcome.state = skipped ? 'skipped' : 'failed'
  }

  let contiguousEndMs = 0
  for (const outcome of outcomes) {
    if (outcome.state === 'failed') break
    contiguousEndMs = outcome.endMs
  }
  const skippedWindows = outcomes.filter((o) => o.state === 'skipped').length
  const firstError = outcomes.find((o) => o.state === 'failed')?.error ?? null

  // A window we could not read is not a window with no data. Advancing over it marks days as
  // synced that nothing ever read, and intraday samples only stay fetchable for a recent window,
  // so those days are gone at that resolution rather than merely late.
  //
  // Both kinds of drift go in one record because last_error holds one string. Written
  // separately, whichever ran second would erase the other, and the two need different fixes:
  // a moved value path against an envelope this code can no longer read at all.
  const drifted = [
    unreadableWindows > 0 ? `${unreadableWindows} unreadable pages across ${windows.length} windows` : null,
    points > 0 && rowsWritten === 0 && !t.mappingDeferred ? `${points} points fetched and none mapped to a row` : null,
  ].filter((reason) => reason !== null)
  if (drifted.length > 0) {
    deps.syncState.recordSchemaDrift({
      personId: input.personId, dataType: t.id, points, nowMs: deps.now(),
      reason: drifted.join('; '),
    })
  }

  // After the drift record, so last_error keeps the failure. A job whose only failures are windows
  // already given up on records none: they stay visible through skippedWindowsFor, and the type
  // is not failing for them. consecutive_failures therefore moves once per job, not per window.
  if (failedWindows > skippedWindows) {
    recordFailureSafely(deps.syncState, {
      personId: input.personId, dataType: t.id, error: classify(firstError), nowMs: deps.now(),
    })
  }

  if (contiguousEndMs > 0 && unreadableWindows === 0) {
    const nowMs = deps.now()
    // Clamped, because today's window ends at the *next* local midnight and the mark would
    // otherwise sit up to a day ahead of now. A mark in the future is a claim to have synced
    // time that has not happened yet, and runSync's gap repair reads it as coverage: left
    // unclamped it would quietly subtract a day from what every run reaches back for.
    const mark = { personId: input.personId, dataType: t.id, highWaterMs: Math.min(contiguousEndMs, nowMs) }
    if (failedWindows > skippedWindows) deps.syncState.advanceHighWater(mark)
    else deps.syncState.recordSuccess({ ...mark, nowMs })
  }
  // Nothing threw, so nothing else in this job will ever mention it: the pages were full, the
  // points parsed, and every one of them was skipped by a mapper that could not find its field.
  // Left unreported, a rename upstream reads exactly like a person who stopped wearing a device.
  // Types whose mapping is deferred are excluded, because writing no rows is their design.

  return finish({ windows: windows.length, points, rowsWritten, unreadableWindows, failedWindows, skippedWindows, rateLimited, skipped: null })
}

// A store that cannot record the failure (disk full, locked) must not replace the window error
// with its own throw: that would escape runSync and end the whole run for every person.
export function recordFailureSafely(
  syncState: SyncStateStore,
  input: { personId: string, dataType: string, error: Error, nowMs: number },
): void {
  try {
    syncState.recordFailure(input)
  } catch (storeError) {
    // The window error would otherwise vanish with the failed write, so it is logged here as
    // classified messages only, never raw objects.
    console.error(
      `sync: could not record sync failure for ${input.dataType} (${classify(storeError).message}); window error: ${input.error.message}`,
    )
  }
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

/** What a window wrote, and which local days it landed on, which is what the queue is marked with. */
interface Written { rows: number, localDates: string[] }

function writeSamples(tx: Parameters<Parameters<Database['transaction']>[0]>[0], args: {
  dataType: DataType, personId: string, resolveSource: (d: unknown) => string,
  pages: Array<{ body: string, rawPayloadId: string }>, keys: SampleKeys,
}): Written {
  const rows = mapWindowSamples(args)
  // Before the upsert: the stored offsets it is compared with are about to be overwritten.
  const localDates = sampleDirtyDates(tx, rows, args.keys)
  // Prepared once per window rather than once per row, for the reason replay.ts's identical
  // statement spells out: drizzle prepares a new better-sqlite3 statement on every
  // `insert().values().run()`, and better-sqlite3 keeps every statement a connection ever prepares
  // so it can finalise them on close. A forced GC reclaims none of it. The rebuild is where that
  // became an outage (#275), and it is worth fixing here too because this connection is the
  // server's and it lives for the life of the process: left per row, an instance's memory grew
  // with every sample sync had ever written and only a restart gave it back.
  const insertSample = tx.insert(samples).values({
    personRef: sql.placeholder('personRef'),
    sourceRef: sql.placeholder('sourceRef'),
    metricRef: sql.placeholder('metricRef'),
    utcMs: sql.placeholder('utcMs'),
    tzOffsetMinutes: sql.placeholder('tzOffsetMinutes'),
    aggRef: sql.placeholder('aggRef'),
    value: sql.placeholder('value'),
    n: sql.placeholder('n'),
    rawPayloadRef: sql.placeholder('rawPayloadRef'),
  } as unknown as typeof samples.$inferInsert).onConflictDoUpdate({
    target: [samples.personRef, samples.sourceRef, samples.metricRef, samples.utcMs, samples.aggRef],
    set: {
      value: sql.placeholder('value'),
      n: sql.placeholder('n'),
      tzOffsetMinutes: sql.placeholder('tzOffsetMinutes'),
      rawPayloadRef: sql.placeholder('rawPayloadRef'),
    } as unknown as Partial<typeof samples.$inferInsert>,
  }).prepare()
  for (const row of rows) {
    // Translated here rather than in the mapper: mapWindowSamples reads a provider's JSON and has
    // no database to ask. The upsert target has to name the same five columns samples_natural is
    // built on, refs included, or the trailing window every sync re-fetches by design would insert
    // a second copy of every minute it already holds instead of updating it.
    const stored = args.keys.sampleRefs(row)
    insertSample.run(stored)
  }
  return { rows: rows.length, localDates: [...localDates] }
}

function writeSessions(tx: Parameters<Parameters<Database['transaction']>[0]>[0], args: {
  dataType: DataType, personId: string, resolveSource: (d: unknown) => string,
  pages: Array<{ body: string, rawPayloadId: string }>,
}): Written {
  let written = 0
  // A session's own localDate is already localDateOf its end instant and end offset: a night
  // spanning midnight belongs to the morning, which is invariant 3 and is decided by mapSessions.
  const localDates = new Set<string>()
  for (const page of args.pages) {
    const { sessions: rows, segments } = mapSessions({
      dataType: args.dataType, personId: args.personId, resolveSource: args.resolveSource,
      body: page.body, rawPayloadId: page.rawPayloadId,
    })
    for (const row of rows) {
      // A session that moved days leaves derived rows behind on the day it left. localDate is in
      // the set clause below, so Google revising an end time across midnight legitimately moves
      // one, and the day it left is only rewritten if the queue is told it is dirty.
      const previous = tx.select({ localDate: sessions.localDate })
        .from(sessions).where(eq(sessions.id, row.id)).get()
      if (previous && previous.localDate !== row.localDate) localDates.add(previous.localDate)
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
      localDates.add(row.localDate)
      // A sleep session joins or leaves a chain that can reach the night on the next or the
      // previous date, so those are re-derived too. The ingest route marks them separately and
      // keeps them out of its own dates; here they are marked with the rest.
      if (row.kind === 'sleep') {
        for (const date of sleepNeighbourDates([row.localDate, previous?.localDate].filter((d): d is string => d !== undefined))) {
          localDates.add(date)
        }
      }
    }
    // Segments are replaced wholesale for the sessions in this page: a re-fetch after Google
    // finishes processing a night legitimately changes the stage timeline, and merging two
    // versions of it would interleave them.
    for (const row of rows) tx.delete(sessionSegments).where(eq(sessionSegments.sessionId, row.id)).run()
    for (const segment of segments) tx.insert(sessionSegments).values(segment).run()
  }
  return { rows: written, localDates: [...localDates] }
}

function writeObservations(tx: Parameters<Parameters<Database['transaction']>[0]>[0], args: {
  dataType: DataType, personId: string, resolveSource: (d: unknown) => string,
  pages: Array<{ body: string, rawPayloadId: string }>,
}): Written {
  const store = new ObservationStore(tx)
  const rows = args.pages.flatMap((page) => mapObservations({
    dataType: args.dataType, personId: args.personId, resolveSource: args.resolveSource,
    body: page.body, rawPayloadId: page.rawPayloadId,
  }))
  store.writeMany(rows)
  const localDates = new Set(rows.map((row) => row.localDate))
  return { rows: rows.length, localDates: [...localDates] }
}
