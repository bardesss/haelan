import { eq } from 'drizzle-orm'
import { people } from '../db/schema/index.ts'
import { dataTypeById } from '../api/catalogue.ts'
import { runJob } from './runJob.ts'
import type { JobDeps } from './runJob.ts'

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
  deps: JobDeps
}

const DAY_MS = 86_400_000

// Spec section 8: every run re-fetches a trailing window rather than only the range since the
// cursor, because devices upload late and a pure cursor would miss that data permanently.
export async function runSync(input: SyncInput): Promise<SyncReport> {
  const report: SyncReport = { jobs: 0, succeeded: 0, failed: 0, skipped: 0, rowsWritten: 0, unknownPersonIds: [] }
  const toMs = input.deps.now()
  const fromMs = toMs - input.trailingDays * DAY_MS

  for (const personId of input.personIds) {
    const person = input.deps.db.select().from(people).where(eq(people.id, personId)).get()
    // A person id that was valid when the caller assembled the list and is gone by the time the
    // loop reaches it must not take the rest of the household down with it. Sync never crashes,
    // so the id is reported back instead of thrown out of the run.
    if (!person) {
      report.unknownPersonIds.push(personId)
      continue
    }

    for (const job of input.deps.syncState.dueJobs([personId], toMs)) {
      const dataType = dataTypeById(job.dataType)
      if (!dataType) continue
      report.jobs++
      const before = input.deps.syncState.get(personId, job.dataType)?.consecutiveFailures ?? 0
      const result = await runJob({
        personId, dataType, timezone: person.timezone, fromMs, toMs, deps: input.deps,
      })
      report.rowsWritten += result.rowsWritten
      if (result.skipped) report.skipped++
      else if ((input.deps.syncState.get(personId, job.dataType)?.consecutiveFailures ?? 0) > before) report.failed++
      else report.succeeded++
    }
  }

  return report
}
