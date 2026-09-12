import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkoutComparisonCard } from '../src/pages/activity/WorkoutComparison.js'
import { comparisonRange } from '../src/data/useWorkoutComparison.js'

describe('the comparison window', () => {
  it('is the ninety days ending at this workout\'s own local date', () => {
    expect(comparisonRange('2026-08-03')).toEqual({ from: '2026-05-05', to: '2026-08-03' })
  })
})

describe('the comparison card', () => {
  it('states a count, not a rank', () => {
    const html = renderToStaticMarkup(<WorkoutComparisonCard comparison={{
      exerciseType: 'RUNNING', of: 12, reason: null,
      pace: { better: 8, of: 12 }, heartRate: null, distance: { better: 4, of: 12 },
    }} isPending={false} isError={false} />)
    expect(html).toContain('activity.workout.comparison.pace')
    expect(html).not.toContain('activity.workout.comparison.rank')
  })

  it('withholds itself with its own reason when there are too few prior workouts', () => {
    const html = renderToStaticMarkup(<WorkoutComparisonCard comparison={{
      exerciseType: 'RUNNING', of: 2, reason: 'too-few', pace: null, heartRate: null, distance: null,
    }} isPending={false} isError={false} />)
    expect(html).toContain('activity.workout.comparison.tooFew')
  })

  it('renders no card at all when the workout has no type to compare within', () => {
    expect(renderToStaticMarkup(<WorkoutComparisonCard comparison={{
      exerciseType: null, of: 0, reason: 'no-type', pace: null, heartRate: null, distance: null,
    }} isPending={false} isError={false} />)).toBe('')
  })
})
