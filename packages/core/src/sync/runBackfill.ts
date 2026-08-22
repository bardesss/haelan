import type { DataType } from '../api/catalogue.ts'
import { supports } from '../api/catalogue.ts'
import { dayWindows } from './windows.ts'
import { runJob } from './runJob.ts'
import type { JobDeps } from './runJob.ts'

const DAY_MS = 86_400_000
const DEFAULT_BATCH_DAYS = 14
// One extra day of span so the first aligned window covers the cursor's own day rather than
// starting after it.
const ALIGNMENT_SLACK_MS = DAY_MS

export interface BackfillInput {
  personId: string
  timezone: string
  dataType: DataType
  nowMs: number
  /** Resolved by the caller through horizonDaysFor, because the operator's setting lives above core's sync layer. */
  horizonDays: number
  /** Windows to fetch before yielding, so one type cannot hold the runner indefinitely. */
  batchDays?: number
  deps: JobDeps
}

export interface BackfillResult {
  windowsFetched: number
  rowsWritten: number
  complete: boolean
  stoppedBecause: 'horizon' | 'batch' | 'error' | 'revoked'
}

/**
 * Walks backwards a day at a time from the stored cursor, or from today on the first run,
 * until the type's horizon or the batch limit. The cursor is written after every window, so
 * an instance killed mid-backfill resumes at the day it was on rather than at today.
 */
export async function runBackfill(input: BackfillInput): Promise<BackfillResult> {
  const { deps, dataType: t } = input
  const done = (
    stoppedBecause: BackfillResult['stoppedBecause'],
    complete: boolean,
    windowsFetched: number,
    rowsWritten: number,
  ): BackfillResult => ({ windowsFetched, rowsWritten, complete, stoppedBecause })

  if (!supports(t, 'list')) return done('horizon', true, 0, 0)

  const state = deps.syncState.get(input.personId, t.id)
  if (state?.backfillCompleteAtMs != null) return done('horizon', true, 0, 0)

  const floorMs = input.nowMs - input.horizonDays * DAY_MS
  const batchDays = input.batchDays ?? DEFAULT_BATCH_DAYS
  let cursorMs = state?.backfillCursorMs ?? input.nowMs
  let windowsFetched = 0
  let rowsWritten = 0

  while (windowsFetched < batchDays) {
    if (cursorMs <= floorMs) {
      deps.syncState.markBackfillComplete({ personId: input.personId, dataType: t.id, nowMs: deps.now() })
      return done('horizon', true, windowsFetched, rowsWritten)
    }

    // dayWindows aligns to the person's local midnight, which is the alignment the archive's
    // dedup key depends on. Taking one of its windows is how a backwards walk keeps that
    // alignment without a second implementation of it.
    const candidates = dayWindows({
      fromMs: cursorMs - DAY_MS - ALIGNMENT_SLACK_MS, toMs: cursorMs, timezone: input.timezone,
    })
    // The last window that ends at or before the cursor, not simply the last one. A cursor
    // that is not itself local midnight, which is every first run, sits inside a day whose
    // window ends in the future: fetching it would re-cover ground the trailing sync already
    // owns and would push the high water mark past now.
    const window = candidates.filter((candidate) => candidate.endMs <= cursorMs).at(-1)
    if (!window) return done('horizon', true, windowsFetched, rowsWritten)

    const before = deps.syncState.get(input.personId, t.id)?.consecutiveFailures ?? 0
    const result = await runJob({
      personId: input.personId, dataType: t, timezone: input.timezone,
      fromMs: window.startMs, toMs: window.endMs, deps,
    })
    rowsWritten += result.rowsWritten
    windowsFetched++

    if (result.skipped === 'revoked') return done('revoked', false, windowsFetched, rowsWritten)
    // runJob swallows its own failures and records them, so the failure counter moving is the
    // only signal that this window did not land. Marching on to the horizon after it would
    // mean walking five years of days against an API that is refusing every one of them.
    const after = deps.syncState.get(input.personId, t.id)?.consecutiveFailures ?? 0
    if (after > before) return done('error', false, windowsFetched, rowsWritten)

    cursorMs = window.startMs
    deps.syncState.setBackfillCursor({
      personId: input.personId, dataType: t.id, cursorMs, nowMs: deps.now(),
    })
  }

  return done('batch', false, windowsFetched, rowsWritten)
}
