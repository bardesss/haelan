// The shape both detail pages read a figure in: the value, its usual band, where it stands, and
// whether that is better or worse, all decided here so a web page and a later native screen render
// the same verdict without either computing one.
import { METRICS } from '../derive/metrics.ts'
import { standingOf } from './glance.ts'
import type { GlanceBaseline, GlanceFigure, GlanceStanding, GlanceStripDay } from './glance.ts'

export type Judged = 'better' | 'worse' | null
export type FigureDirection = 'up' | 'down' | 'neutral'

export interface PageFigure {
  metric: string
  value: number | null
  unit: string
  precision: number
  direction: FigureDirection
  baseline: GlanceBaseline | null
  standing: GlanceStanding | null
  judged: Judged
  strip: GlanceStripDay[] | null
}

export function judge(standing: GlanceStanding | null, direction: FigureDirection): Judged {
  if (standing === null || standing === 'within' || direction === 'neutral') return null
  return (standing === 'above') === (direction === 'up') ? 'better' : 'worse'
}

// Mean and sample deviation, the same band baselineOf draws, but with the caller's own minimum:
// sixty nights and twenty workouts are different amounts of evidence.
export function usualOf(values: readonly number[], minN: number): GlanceBaseline | null {
  const n = values.length
  if (n === 0) return null
  const center = values.reduce((sum, v) => sum + v, 0) / n
  const spread = n === 1 ? 0 : Math.sqrt(values.reduce((sum, v) => sum + (v - center) ** 2, 0) / (n - 1))
  return { center, low: center - spread, high: center + spread, thin: n < minN }
}

/**
 * The catalogue metric a figure is described by, for the figures whose own metric is not a
 * catalogue id. Active minutes is the three activity levels summed, all sharing one precision and
 * one direction (up), so it reads as one of them does. One map for both the judging here and the
 * server's rounding, so the precision a figure is judged at and the one it is sent at cannot part.
 */
export const FIGURE_METRIC_ALIAS: Readonly<Record<string, string>> = { active_minutes: 'active_minutes_light' }

export function pageFigureOf(figure: GlanceFigure, withStrip: boolean): PageFigure {
  const spec = METRICS[FIGURE_METRIC_ALIAS[figure.metric] ?? figure.metric]
  const direction = spec?.direction ?? 'neutral'
  return {
    metric: figure.metric, value: figure.value, unit: figure.unit, precision: spec?.precision ?? 0, direction,
    baseline: figure.baseline, standing: figure.standing, judged: judge(figure.standing, direction),
    strip: withStrip ? figure.strip : null,
  }
}

export function figureFromValues(o: {
  metric: string, unit: string, precision: number, direction: FigureDirection,
  value: number | null, history: readonly number[], minN: number,
}): PageFigure {
  const baseline = usualOf(o.history, o.minN)
  const standing = standingOf(o.value, baseline, false)
  return {
    metric: o.metric, value: o.value, unit: o.unit, precision: o.precision, direction: o.direction,
    baseline, standing, judged: judge(standing, o.direction), strip: null,
  }
}
