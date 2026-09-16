import { useTranslation } from '../../i18n/index.js'
import { COMPARISON_LIMIT, COMPARISON_WINDOW_DAYS } from '@haelan/core/workout-comparison'
import type { WorkoutComparison as WorkoutComparisonResult } from '@haelan/core/workout-comparison'
import { useWorkoutComparison } from '../../data/useWorkoutComparison.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { Card } from '../../components/Card.js'
import { Loading } from '../../components/Loading.js'
import { EmptyState } from '../../components/EmptyState.js'

/** Presentational, the way InsightCard is: the page owns the hook and hands the result down, so
 *  both withheld branches below are testable without stubbing a network call. */
export function WorkoutComparisonCard({ comparison, isPending, isError }: {
  comparison: WorkoutComparisonResult | null
  isPending: boolean
  isError: boolean
}) {
  const { t } = useTranslation()
  // Checked before the null guard below: isPending is true exactly while comparison is still null
  // (the hook has not yet resolved its own query), so a null check ahead of this one would make
  // this branch unreachable and a cold mount would show no card at all rather than a loading one.
  if (isPending) return <Card span={12} label={t('activity.workout.comparison.label')}><Loading /></Card>
  // A failed list is not the same statement as a thin one, and neither is worth a card of its own
  // here: the comparison is an extra on this page, not the reason a reader opened it.
  if (isError || comparison === null) return null
  // No type means there is no set to compare within at all, which is not a thin period - it is a
  // question that cannot be asked. Nothing to withhold, so nothing to render.
  if (comparison.reason === 'no-type') return null
  if (comparison.reason === 'too-few') {
    return (
      <Card span={12} label={t('activity.workout.comparison.label')}>
        <EmptyState title={t('activity.workout.comparison.tooFew')}
          detail={t('activity.workout.comparison.tooFewDetail', { count: comparison.of })} />
      </Card>
    )
  }

  const sentences = [
    comparison.pace === null ? null
      : t('activity.workout.comparison.pace', { better: comparison.pace.better, of: comparison.pace.of }),
    comparison.heartRate === null ? null
      : t('activity.workout.comparison.heartRate', { better: comparison.heartRate.better, of: comparison.heartRate.of }),
    comparison.distance === null ? null
      : t('activity.workout.comparison.distance', { better: comparison.distance.better, of: comparison.distance.of }),
    // Last, because it is the only one of the four a reader cannot judge without it. A pace is
    // fast or slow on its own terms; a cardio load of 86 is a number with no scale attached until
    // this sentence gives it one. "Harder than", never a band or a colour - TrainingLoadCard
    // refuses to read this family of figure as risk and says why, and a verdict here would cross
    // the same line more quietly.
    comparison.cardioLoad === null ? null
      : t('activity.workout.comparison.cardioLoad', { better: comparison.cardioLoad.better, of: comparison.cardioLoad.of }),
  ].filter((sentence): sentence is string => sentence !== null)

  if (sentences.length === 0) return null

  return (
    <Card span={12} label={t('activity.workout.comparison.label')}
      basis={t('activity.workout.comparison.basis', { days: COMPARISON_WINDOW_DAYS, limit: COMPARISON_LIMIT })}>
      <ul className="workout-comparison">
        {sentences.map((sentence) => <li key={sentence}>{sentence}</li>)}
      </ul>
    </Card>
  )
}

/**
 * Owns the hook and hands the result to the presentational card above. `session` is required
 * (not `WorkoutSession | undefined`, unlike useWorkoutComparison's own parameter) because this
 * component is mounted only inside WorkoutDetail's `.grid`, which the page reaches only once its
 * own session query has left both isPending and isError - so this never sees an unresolved
 * session, and useWorkoutComparison never fetches against an empty range.
 */
export function WorkoutComparison({ session }: { session: WorkoutSession }) {
  const { comparison, isPending, isError } = useWorkoutComparison(session)
  return <WorkoutComparisonCard comparison={comparison} isPending={isPending} isError={isError} />
}
