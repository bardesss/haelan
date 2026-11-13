import type { DataType } from '../api/catalogue.ts'
import { supports } from '../api/catalogue.ts'
import { dayWindows, startOfLocalDay } from './windows.ts'
import type { Window } from './windows.ts'
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
  stoppedBecause: 'horizon' | 'batch' | 'error' | 'revoked' | 'credentials_unreadable' | 'rate_limited'
}

/**
 * The window the walk fetches next. dayWindows aligns to the person's local midnight, which is
 * the alignment the archive's dedup key depends on, so a backwards walk takes one of its windows
 * rather than keeping a second implementation of it.
 */
export function nextBackfillWindow(cursorMs: number, timezone: string, cursorIsStored: boolean): Window | undefined {
  // A stored cursor that is not local midnight in the current zone was written under another
  // zone. The day containing the instant just before it is the one still unfetched, and the
  // filter below would instead skip it and leave a gap.
  if (cursorIsStored && startOfLocalDay(cursorMs, timezone) !== cursorMs) {
    return dayWindows({ fromMs: cursorMs - 1, toMs: cursorMs, timezone })[0]
  }
  const candidates = dayWindows({
    fromMs: cursorMs - DAY_MS - ALIGNMENT_SLACK_MS, toMs: cursorMs, timezone,
  })
  // The last window that ends at or before the cursor, not simply the last one. A first run's
  // cursor is not local midnight and sits inside a day whose window ends in the future:
  // fetching it would re-cover ground the trailing sync already owns and would push the high
  // water mark past now.
  return candidates.filter((candidate) => candidate.endMs <= cursorMs).at(-1)
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
  let cursorIsStored = state?.backfillCursorMs != null
  let windowsFetched = 0
  let rowsWritten = 0

  while (windowsFetched < batchDays) {
    if (cursorMs <= floorMs) {
      deps.syncState.markBackfillComplete({ personId: input.personId, dataType: t.id, nowMs: deps.now() })
      return done('horizon', true, windowsFetched, rowsWritten)
    }

    const window = nextBackfillWindow(cursorMs, input.timezone, cursorIsStored)
    if (!window) return done('horizon', true, windowsFetched, rowsWritten)

    const result = await runJob({
      personId: input.personId, dataType: t, timezone: input.timezone,
      fromMs: window.startMs, toMs: window.endMs, deps,
    })
    rowsWritten += result.rowsWritten
    windowsFetched++

    if (result.skipped === 'revoked') return done('revoked', false, windowsFetched, rowsWritten)
    if (result.skipped === 'credentials_unreadable') {
      return done('credentials_unreadable', false, windowsFetched, rowsWritten)
    }
    // Before the generic failure check, which a rate limited job also trips: the walk stops either
    // way, but the caller reads the reason, and a quota is not a bad window.
    if (result.rateLimited) return done('rate_limited', false, windowsFetched, rowsWritten)
    // runJob swallows its own failures and records them, so its own count is the signal that
    // this window did not land. Marching on to the horizon after it would mean walking five years
    // of days against an API that is refusing every one of them. A window runSync already gave
    // up on is passed over like a good one, or the walk could never get beyond it.
    if (result.failedWindows > result.skippedWindows) return done('error', false, windowsFetched, rowsWritten)

    // Drift is not a failure, so the counter above never moves for it, and a backfill is one
    // shot: it would walk the whole horizon against bodies it cannot read, advance the cursor
    // over every one of them, and then declare the history collected. Stopping leaves the
    // cursor where the last readable window put it.
    if (result.unreadableWindows > 0) return done('error', false, windowsFetched, rowsWritten)

    cursorMs = window.startMs
    deps.syncState.setBackfillCursor({
      personId: input.personId, dataType: t.id, cursorMs, nowMs: deps.now(),
    })
    cursorIsStored = true
  }

  return done('batch', false, windowsFetched, rowsWritten)
}
