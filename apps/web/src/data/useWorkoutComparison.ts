import { useMemo } from 'react'
import { compareWorkout, COMPARISON_WINDOW_DAYS } from '@haelan/core/workout-comparison'
import type { WorkoutComparison } from '@haelan/core/workout-comparison'
import { useSessions } from './useSessions.js'
import type { WorkoutSession } from './useSessions.js'
import { ALL_SOURCES } from '../controls/source.js'
import { addDays } from '../controls/range.js'

/** The trailing window, in local dates, taken from the session's own localDate rather than from
 *  its startMs: the row already carries the local date the derivation filed it under, so this
 *  needs no timezone arithmetic of its own and cannot disagree with it. */
export function comparisonRange(localDate: string): { from: string, to: string } {
  return { from: addDays(localDate, -COMPARISON_WINDOW_DAYS), to: localDate }
}

/**
 * The comparison set is the existing sessions list over a trailing window, filtered in core. No
 * third endpoint: an ordering over rows an existing endpoint already returns is not a query.
 *
 * Every source, not the session's own: a person who ran with a watch one week and a phone the next
 * ran twice, and comparing a run only against the runs its own device recorded would answer a
 * question nobody asked.
 *
 * `session` may be undefined so the hook itself never has to be skipped conditionally, but its
 * one caller (WorkoutComparison, in WorkoutComparison.tsx) is mounted only inside WorkoutDetail's
 * `.grid`, which is only reached once the page's own session query has left both isPending and
 * isError - so in practice this always receives a resolved session and useSessions is never asked
 * to fetch an empty range.
 */
export function useWorkoutComparison(session: WorkoutSession | undefined): {
  comparison: WorkoutComparison | null
  isPending: boolean
  isError: boolean
} {
  const range = session === undefined ? { from: '', to: '' } : comparisonRange(session.localDate)
  const query = useSessions({ kind: 'exercise', from: range.from, to: range.to, source: ALL_SOURCES })

  const comparison = useMemo(() => {
    if (session === undefined || query.data === undefined) return null
    return compareWorkout(session, query.data.items)
  }, [session, query.data])

  return { comparison, isPending: query.isPending, isError: query.isError }
}
