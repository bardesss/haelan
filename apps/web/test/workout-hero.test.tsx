import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import type { Sparkline } from '../src/charts/Sparkline.js'
import { WorkoutHero } from '../src/pages/activity/workout/WorkoutHero.js'
import { PREVIOUS_DATE, PREVIOUS_ID, WORKOUT_DATE, workoutPageFixture } from './fixtures/workoutPage.js'

// The strip's props, read the way night-hero.test.tsx reads the night's: echarts never mounts
// under static rendering, and what the hero hands the chart is the whole question. The workout's
// hero is wired as the night's is, so this file asks the night's questions of it.
let sparklineProps: ComponentProps<typeof Sparkline> | null = null
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: ComponentProps<typeof Sparkline>) => {
    sparklineProps = props
    return null
  },
}))

const render = (onOpenWorkout?: (sessionId: string) => void) => renderToStaticMarkup(
  <I18nProvider lng="en"><WorkoutHero page={workoutPageFixture()} onOpenWorkout={onOpenWorkout} /></I18nProvider>,
)

describe('the workout page\'s hero strip', () => {
  beforeEach(() => { sparklineProps = null })

  it('labels the usual band\'s edges, as the night\'s and the dashboard\'s strips do', () => {
    render()
    expect(sparklineProps?.baseline).toEqual({ center: 329, low: 322, high: 336, thin: false })
    expect(sparklineProps?.bandLabels).toEqual({ low: '5:22 /km', high: '5:36 /km' })
  })

  // The fixture's pace strip: 340 and 336 sit above the usual 322-336 and a higher pace is slower,
  // so those sessions were judged worse; the rest sit inside it.
  it('hands each dot its session\'s verdict, so it takes the tone its verdict line would', () => {
    render()
    expect(sparklineProps?.pointStandings?.[0]).toBe('above')
    expect(sparklineProps?.pointJudged?.[0]).toBe('worse')
    expect(sparklineProps?.pointStandings?.at(-1)).toBe('within')
    expect(sparklineProps?.pointJudged?.at(-1)).toBeNull()
  })

  it('opens a clicked session on its own page, and not the one already shown', () => {
    const open = vi.fn()
    render(open)
    sparklineProps!.onPointClick!(PREVIOUS_DATE)
    expect(open.mock.calls).toEqual([[PREVIOUS_ID]])
    expect(sparklineProps!.opensDay?.current).toBe(WORKOUT_DATE)
    // Worded for what a dot opens: a workout, not a day.
    expect(sparklineProps!.opensDay?.tail).toBe('Open this workout')
    expect(sparklineProps!.opensDay?.idle).toBe('Tap a workout to open it')
  })

  it('is a plain strip with nowhere to open a workout', () => {
    render(undefined)
    expect(sparklineProps!.onPointClick).toBeUndefined()
    expect(sparklineProps!.opensDay).toBeUndefined()
  })

  // Described by the verdict it prints beside the strip, not by a hidden second copy of it.
  it('says its verdict once', () => {
    const html = render()
    expect(html.split('within your usual 5:22 – 5:36 /km')).toHaveLength(2)
    expect(html).not.toContain('sr-only')
  })
})
