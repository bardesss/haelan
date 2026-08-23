import { eq } from 'drizzle-orm'
import { people } from '../db/schema/index.ts'
import { dataTypeById, horizonDaysFor, supports } from '../api/catalogue.ts'
import { runJob, classify } from './runJob.ts'
import type { JobDeps } from './runJob.ts'
import { runRollupJob } from './runRollupJob.ts'
import { RevokedError } from '../api/tokens.ts'

export interface SyncReport {
  jobs: number
  succeeded: number
  failed: number
  skipped: number
  rowsWritten: number
  /** Ids in the caller's list with no person row. Reported rather than thrown; see runSync. */
  unknownPersonIds: string[]
}

export interface SyncInput {
  personIds: string[]
  trailingDays: number
  /**
   * The account's chosen depth, which horizonDaysFor turns into a per-type ceiling. Required
   * rather than defaulted because it bounds how far a gap repair may reach: a default here would
   * silently let one run walk further back than the account ever asked to keep.
   */
  userHorizonDays: number
  deps: JobDeps
  /**
   * Asked between people and between jobs. A shutdown sets this, and the run then returns what it
   * has finished instead of walking every remaining person and type while settle() waits on it.
   *
   * Between jobs rather than inside one: a job is transactional and withholds its own cursor when
   * it cannot trust what it read, so abandoning the run at a job boundary leaves sync state
   * consistent and the next run simply picks the remaining jobs up. Stopping mid job would buy a
   * few hundred milliseconds and cost that guarantee.
   */
  shouldStop?: () => boolean
}

const DAY_MS = 86_400_000

/**
 * How far back one run reaches for a type, which is the trailing window *or* the gap since this
 * mirror actually stops, whichever is further.
 *
 * Spec section 8: every run re-fetches a trailing window rather than only the range since the
 * mark, because devices upload late and a pure cursor would miss that data permanently. But the
 * trailing window alone is a fixed span ending at now, so an outage longer than the span leaves
 * days nothing ever asks for again: the trailing run has moved past them and the backfill cursor
 * only walks backwards. Spec section 16 promises those days come back, and the high-water mark
 * is the only record of where they start.
 *
 * Clamped to the type's horizon so a very old mark cannot pull one run deeper than the account
 * ever asked to keep. A long gap therefore costs one large run rather than a permanent hole, and
 * because the mark only advances as far as a run actually got, an interrupted repair resumes
 * from where it stopped rather than starting over.
 */
export function reachBackTo(
  highWaterMs: number | null, trailingFromMs: number, toMs: number,
  dataType: Parameters<typeof horizonDaysFor>[0], userHorizonDays: number,
): number {
  if (highWaterMs === null) return trailingFromMs
  const horizonFloorMs = toMs - horizonDaysFor(dataType, userHorizonDays) * DAY_MS
  return Math.max(horizonFloorMs, Math.min(trailingFromMs, highWaterMs))
}

export async function runSync(input: SyncInput): Promise<SyncReport> {
  const report: SyncReport = { jobs: 0, succeeded: 0, failed: 0, skipped: 0, rowsWritten: 0, unknownPersonIds: [] }
  const toMs = input.deps.now()
  const trailingFromMs = toMs - input.trailingDays * DAY_MS

  for (const personId of input.personIds) {
    // Before the person is even looked up, so a stop reaches the household member who has not
    // started rather than only the one already under way.
    if (input.shouldStop?.() === true) return report
    const person = input.deps.db.select().from(people).where(eq(people.id, personId)).get()
    // A person id that was valid when the caller assembled the list and is gone by the time the
    // loop reaches it must not take the rest of the household down with it. Sync never crashes,
    // so the id is reported back instead of thrown out of the run.
    if (!person) {
      report.unknownPersonIds.push(personId)
      continue
    }

    for (const job of input.deps.syncState.dueJobs([personId], toMs)) {
      if (input.shouldStop?.() === true) return report
      const dataType = dataTypeById(job.dataType)
      if (!dataType) continue

      if (!supports(dataType, 'list')) {
        // A type answering only rollups has no windows, no high water mark and no per source
        // rows. It is a different walk, and treating it as a failed list job is how it stayed
        // unreadable through the whole of M1.
        if (!supports(dataType, 'dailyRollUp')) continue
        report.jobs++
        const rollupHighWaterMs = input.deps.syncState.get(personId, job.dataType)?.highWaterMs ?? null
        // Nothing else ever walks these types deeper: the backfill pass skips anything that
        // cannot list, so this run is their whole read path. With no mark, reachBackTo returns
        // the trailing window, which means a first run would reach back a week, stamp a mark,
        // and leave every account's history before install unfetched for good. The first run
        // therefore walks the type's full horizon; from the second on, the mark exists and
        // reachBackTo governs the reach exactly as it does for a list job.
        const rollupFromMs = rollupHighWaterMs === null
          ? toMs - horizonDaysFor(dataType, input.userHorizonDays) * DAY_MS
          : reachBackTo(rollupHighWaterMs, trailingFromMs, toMs, dataType, input.userHorizonDays)
        try {
          const rollup = await runRollupJob({
            personId, dataType, timezone: person.timezone,
            fromMs: rollupFromMs, toMs, deps: input.deps,
          })
          report.rowsWritten += rollup.rowsWritten
          // Mirrors runJob: only stamp a mark once the walk actually covered something, and the
          // mark is toMs itself (already now, never later), so it can never claim to have synced
          // time that has not happened yet.
          // A chunk we could not read is not a chunk with no data, and only the walk can tell
          // them apart. Stamping the mark here would scroll the cursor past days nothing ever
          // read, and a rollup type has no backfill pass to come back for them.
          if (rollup.chunks > 0 && rollup.unreadable === 0) {
            input.deps.syncState.recordSuccess({ personId, dataType: job.dataType, highWaterMs: toMs, nowMs: toMs })
          }
          report.succeeded++
        } catch (error) {
          // A rolled-back window's stale sources cache is runJob's problem, not this one: a
          // rollup writes only to daily, which carries no source foreign key to go stale.
          if (error instanceof RevokedError) { report.skipped++; continue }
          input.deps.syncState.recordFailure({
            personId, dataType: job.dataType, error: classify(error), nowMs: toMs,
          })
          report.failed++
        }
        continue
      }

      report.jobs++
      const state = input.deps.syncState.get(personId, job.dataType)
      const before = state?.consecutiveFailures ?? 0
      const result = await runJob({
        personId, dataType, timezone: person.timezone,
        fromMs: reachBackTo(state?.highWaterMs ?? null, trailingFromMs, toMs, dataType, input.userHorizonDays),
        toMs, deps: input.deps,
      })
      report.rowsWritten += result.rowsWritten
      if (result.skipped) report.skipped++
      else if ((input.deps.syncState.get(personId, job.dataType)?.consecutiveFailures ?? 0) > before) report.failed++
      else report.succeeded++
    }
  }

  try {
    // Guarded for the same reason runJob guards its own: a broken SSE client must not turn a
    // finished run into a thrown one.
    input.deps.onProgress?.({
      kind: 'run_finished', jobs: report.jobs, rowsWritten: report.rowsWritten, failed: report.failed,
    })
  } catch { /* ignore */ }
  return report
}
