import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure, PeriodRange, TypeTotal, WorkoutListRow, WorkoutMonth } from '../../../data/periodTypes.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
import { formatFigureValue } from '../../detail/figureText.js'
import { monthName, thisPeriod } from '../../detail/periodText.js'
import { ExpandableList, LIST_VISIBLE } from '../../period/ExpandableList.js'
import { SessionRowView } from '../SessionRow.js'

// Every type, and a workout with none, each as a filter value of its own.
const ALL = '*'
const UNTYPED = ''
const typeValue = (type: string | null) => type ?? UNTYPED

const keyOf = (workout: WorkoutListRow) => workout.id
const monthOf = (workout: WorkoutListRow) => workout.localDate.slice(0, 7)
const grouped = (range: PeriodRange) => range === '3months' || range === 'year'

const render = (workout: WorkoutListRow): ReactNode => (
  <SessionRowView id={workout.id} type={workout.type} startMs={workout.startMs} durationSeconds={workout.durationSeconds}
    distanceMeters={workout.distanceMeters} caloriesKcal={workout.caloriesKcal} averageHeartRateBpm={workout.averageHeartRateBpm}
    paceSecondsPerKm={workout.paceSecondsPerKm} speedMetersPerSecond={workout.speedMetersPerSecond ?? null} elevationGainMeters={workout.elevationGainMeters}
    excluded={workout.excluded} localDate={workout.localDate} dated />
)

/**
 * "Trainingen": the period's workouts, newest first as the server sends them, excluded ones
 * included and struck through (SessionRowView), under a caption with the server's count and the
 * period's workout time, the seven most recent and the rest behind "Show all 12 workouts"
 * (ExpandableList). On 3 months and Year the list is grouped by month, each month's header naming
 * its workouts on the right as the server counts them (`workoutMonths`, "11 workouts"). Expanded, it
 * offers a filter by type, the approved mockup's row of chips: "All 12" names the rows it shows,
 * excluded ones among them, and each type its count as the server counts it (`types`). The page owns `expanded`, since the card's width follows it;
 * the filter is the list's own, and a new period (the page keys this card by it) starts on all.
 */
export function ActivityWorkouts({ workouts, workoutMonths, types, workoutCount, workoutTime, range, span, expanded, onToggle }: {
  workouts: WorkoutListRow[]
  workoutMonths: WorkoutMonth[]
  types: TypeTotal[]
  workoutCount: number
  /** The period's `workout_minutes` figure, whose total the caption names, or null. */
  workoutTime: PeriodFigure | null
  range: PeriodRange
  span: number
  expanded: boolean
  onToggle: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const [filter, setFilter] = useState(ALL)

  // The server's types first, in its order and with its counts; then any type only an excluded
  // workout has, which the server counts nowhere and so carries no count.
  const options = useMemo(() => {
    const counted = types.map((type) => ({ value: typeValue(type.type), type: type.type, count: type.count as number | null }))
    const seen = new Set(counted.map((option) => option.value))
    const rest: typeof counted = []
    for (const workout of workouts) {
      const value = typeValue(workout.type)
      if (seen.has(value)) continue
      seen.add(value)
      rest.push({ value, type: workout.type, count: null })
    }
    return [...counted, ...rest]
  }, [types, workouts])
  const items = useMemo(
    () => (filter === ALL ? workouts : workouts.filter((workout) => typeValue(workout.type) === filter)),
    [workouts, filter],
  )
  const monthLabel = useCallback((month: string) => monthName(month, language), [language])
  // A month holding only excluded workouts counts none, and its header names no count.
  const monthAside = useCallback((month: string) => {
    const counted = workoutMonths.find((m) => m.month === month)
    return counted === undefined ? null : t('activity.period.workouts.count', { count: counted.count })
  }, [workoutMonths, t])
  const showAll = useCallback((count: number) => t('activity.period.workouts.showAll', { count }), [t])

  const period = thisPeriod(range, t)
  const time = workoutTime?.total ?? null
  const caption = time === null || workoutTime === null
    ? t('activity.period.workouts.captionNoTime', { count: workoutCount, period })
    : t('activity.period.workouts.caption', { count: workoutCount, period, duration: formatFigureValue(workoutTime, time, language, t) })
  const byMonth = grouped(range)
  const filtering = expanded && options.length > 1
  // A filtered list stays open however few it holds, with its "Show fewer", and closing it clears
  // the filter: the chips are the expanded list's own.
  const toggle = useCallback(() => { setFilter(ALL); onToggle() }, [onToggle])

  return (
    <Card span={span} label={t('activity.period.workouts.label')}>
      {filtering && (
        <div className="segmented activity-workout-filter" role="group" aria-label={t('activity.period.workouts.filter')}>
          <button type="button" className="segment" aria-pressed={filter === ALL} onClick={() => setFilter(ALL)}>
            {t('activity.period.workouts.all', { count: workouts.length })}
          </button>
          {options.map((option) => {
            const name = exerciseTypeLabel(t, option.type)
            return (
              <button key={option.value} type="button" className="segment" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
                {option.count === null ? name : t('activity.period.workouts.typeCount', { type: name, count: option.count })}
              </button>
            )
          })}
        </div>
      )}
      <p className="dash-caption night-list-caption">{caption}</p>
      <ExpandableList items={items} keyOf={keyOf} render={render} expanded={expanded} onToggle={toggle} showAll={showAll}
        visible={filter === ALL ? LIST_VISIBLE : 0}
        groupOf={byMonth ? monthOf : undefined} groupLabel={byMonth ? monthLabel : undefined}
        groupAside={byMonth ? monthAside : undefined} groupCollapsed={byMonth} />
    </Card>
  )
}
