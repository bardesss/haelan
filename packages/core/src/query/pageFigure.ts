// The shape both detail pages read a figure in: the value, its usual band, where it stands, and
// whether that is better or worse, all decided here so a web page and a later native screen render
// the same verdict without either computing one.
import { METRICS } from '../derive/metrics.ts'
import { FIGURE_METRIC_ALIAS, judge, standingOf } from './glance.ts'
import type { FigureDirection, GlanceBaseline, GlanceFigure, GlanceStanding, GlanceStripDay, Judged } from './glance.ts'

// Moved to glance.ts once every glance figure and strip day carried a judgement; still exported
// from here, where the detail pages' callers have always found them.
export { FIGURE_METRIC_ALIAS, judge }
export type { FigureDirection, Judged }

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

// Mean and sample deviation, the same band baselineOf draws, but with the caller's own minimum:
// sixty nights and twenty workouts are different amounts of evidence.
export function usualOf(values: readonly number[], minN: number): GlanceBaseline | null {
  const n = values.length
  if (n === 0) return null
  const center = values.reduce((sum, v) => sum + v, 0) / n
  const spread = n === 1 ? 0 : Math.sqrt(values.reduce((sum, v) => sum + (v - center) ** 2, 0) / (n - 1))
  return { center, low: center - spread, high: center + spread, thin: n < minN }
}

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
