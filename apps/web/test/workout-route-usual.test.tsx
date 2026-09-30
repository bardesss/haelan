import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import type { Sparkline } from '../src/charts/Sparkline.js'
import { WorkoutRouteUsual } from '../src/pages/activity/workout/WorkoutRouteUsual.js'
import { ROUTE_PREVIOUS_ID, WORKOUT_ID, workoutPageFixture } from './fixtures/workoutPage.js'

// The route strip's props, read as workout-hero.test.tsx reads the hero's: echarts never mounts
// under static rendering, and what the card hands the chart is the whole question.
// The last strip drawn is the time's; every strip drawn, in order, is `drawnProps`.
let sparklineProps: ComponentProps<typeof Sparkline> | null = null
let drawnProps: ComponentProps<typeof Sparkline>[] = []
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: ComponentProps<typeof Sparkline>) => {
    sparklineProps = props
    drawnProps.push(props)
    return null
  },
}))

const render = (onOpenWorkout?: (sessionId: string) => void) => renderToStaticMarkup(
  <I18nProvider lng="en"><WorkoutRouteUsual page={workoutPageFixture()} span={6} onOpenWorkout={onOpenWorkout} /></I18nProvider>,
)

describe('the same route\'s strip', () => {
  beforeEach(() => { sparklineProps = null; drawnProps = [] })

  it('draws the pace on the route first, upside down too, its dots opening their workouts', () => {
    const open = vi.fn()
    render(open)
    expect(drawnProps.map((p) => p.label)).toEqual(['Pace', 'Moving time'])
    const pace = drawnProps[0]!
    expect(pace.values).toEqual([344, 341, 339, 338, 336, 333, 335, 331, 330, 324])
    expect(pace.inverse).toBe(true)
    pace.onPointClick!(pace.pointIds![0]!)
    expect(open.mock.calls).toEqual([['loop-0']])
  })

  it('draws the times on the route, a lower one higher, over the usual on the route', () => {
    render()
    expect(sparklineProps?.values).toEqual([1810, 1790, 1765, 1750, 1760, 1732, 1745, 1720, 1712, 1684])
    expect(sparklineProps?.inverse).toBe(true)
    expect(sparklineProps?.bands?.at(-1)).toEqual({ low: 1700, high: 1800 })
    expect(sparklineProps?.formatValue?.(1712, '—')).toBe('28:32')
  })

  it('opens a clicked workout on the route by its own id, and not the one already shown', () => {
    const open = vi.fn()
    render(open)
    const ids = sparklineProps!.pointIds!
    expect(ids.at(-1)).toBe(WORKOUT_ID)
    sparklineProps!.onPointClick!(ids[8]!)
    expect(open.mock.calls).toEqual([[ROUTE_PREVIOUS_ID]])
    expect(sparklineProps!.opensDay?.current).toBe(WORKOUT_ID)
    expect(sparklineProps!.opensDay?.tail).toBe('Open this workout')
  })

  it('opens nothing without a way to open a workout', () => {
    render()
    expect(sparklineProps!.onPointClick).toBeUndefined()
    expect(sparklineProps!.opensDay).toBeUndefined()
  })
})
