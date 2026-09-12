import { useIntradayWindow } from './useIntradayWindow.js'
import type { IntradayPoint, IntradayResult } from './useIntraday.js'
import { ALL_SOURCES } from '../controls/source.js'

export type TraceSource = 'pinnedSource' | 'otherSources'

export interface WorkoutTrace {
  points: IntradayPoint[]
  reduction: IntradayResult['reduction']
  traceSource: TraceSource
  /** The source the first request pinned to, for the basis line to name when the fallback fired. */
  pinnedSourceId: string
  isPending: boolean
  isError: boolean
  refetch: () => unknown
}

/**
 * Which source a workout's trace asks for. The route takes startMs, endMs and source and NO session
 * id, so it has no recording device to default to and cannot make this choice; the caller must.
 *
 * Measured 2026-09-12 across 198 exercise sessions, counting which sources hold heart_rate inside
 * each session's span: 189 own device only, 2 own and another, 5 ANOTHER DEVICE ONLY, 2 with no
 * heart rate anywhere. Both naive options are therefore wrong. Never pinning blends two devices into
 * one unlabelled trace for the 2; always pinning draws an empty chart for the 5, where a paired
 * phone recorded the heart rate the watch did not - and an empty chart reads as "no heart rate
 * recorded for this run", which is false.
 *
 * So: pin, and retry unpinned exactly once when the pin came back empty and the reader did not
 * choose a source themselves. An explicit choice never falls back, because empty is the honest
 * answer to a specific question and silently answering a different one is the failure this rule
 * exists to prevent.
 *
 * `get_workout` (apps/server/src/mcp/tools/workouts.ts) implements the same rule and reports which
 * branch ran in its own `traceSource` field. The two surfaces must not diverge: this hook's four
 * cases are the same four that tool's tests pin.
 */
export function useWorkoutTrace(args: {
  metric: string
  startMs: number
  endMs: number
  sessionSourceId: string
  /** The source the reader named, or null when they named none. */
  chosenSource: string | null
}): WorkoutTrace {
  const pinnedSourceId = args.chosenSource ?? args.sessionSourceId
  const pinned = useIntradayWindow({
    metric: args.metric, startMs: args.startMs, endMs: args.endMs, source: pinnedSourceId,
  })

  // Enabled only once the pinned read has actually answered with nothing. `isSuccess` rather than
  // `data !== undefined`: a cached-then-refetching entry carries data while a failed one does not,
  // and the fallback is a statement about an answered, empty request, not about a pending one.
  const pinnedEmpty = pinned.isSuccess && pinned.data.points.length === 0
  const blended = useIntradayWindow(
    { metric: args.metric, startMs: args.startMs, endMs: args.endMs, source: ALL_SOURCES },
    { enabled: args.chosenSource === null && pinnedEmpty },
  )

  const fellBack = args.chosenSource === null && pinnedEmpty
    && blended.isSuccess && blended.data.points.length > 0
  const answered = fellBack ? blended : pinned

  return {
    points: answered.data?.points ?? [],
    reduction: answered.data?.reduction ?? null,
    traceSource: fellBack ? 'otherSources' : 'pinnedSource',
    pinnedSourceId,
    // Pending while the fallback is in flight too: a card that called itself settled between the
    // two requests would render the empty pinned answer for a frame and then replace it, which is
    // the "no heart rate recorded" claim this hook exists to never make.
    isPending: pinned.isPending || (args.chosenSource === null && pinnedEmpty && blended.isPending),
    isError: pinned.isError || blended.isError,
    refetch: () => { void pinned.refetch(); if (fellBack) void blended.refetch() },
  }
}
