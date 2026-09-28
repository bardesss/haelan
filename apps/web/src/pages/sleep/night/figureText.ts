import type { PageFigure } from '../../../data/useNightPage.js'
import { formatClock, formatDuration, formatNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { stripBands } from '../../dashboard/cardShared.js'

/**
 * A figure's own value, or any other number measured in the same unit (its baseline's low, high or
 * center), worded the way that unit reads: a duration for minutes, a clock time for a clock offset,
 * a catalogue-precision number with the unit's own suffix for everything else the server judges by.
 * Takes `value` separately from `figure.value` because `verdictLine` below calls this three more
 * times, on `baseline.low`, `.high` and `.center`, none of which is the figure's own value.
 *
 * Null formats as `common.absent`, never a placeholder string, the same absence rule formatNumber
 * itself keeps (format.ts's own comment on it).
 */
export function formatFigureValue(
  figure: Pick<PageFigure, 'value' | 'unit' | 'metric' | 'precision'>,
  value: number | null,
  language: string,
  t: Translate,
): string {
  const absent = t('common.absent')
  if (value === null) return absent
  switch (figure.unit) {
    case 'minutes': return formatDuration(value)
    case 'minutes_from_local_midnight': return formatClock(value)
    case 'percent': return `${formatNumber(value, figure.precision, language, absent)} ${t('charts.units.percent')}`
    case 'bpm': return `${formatNumber(value, figure.precision, language, absent)} ${t('charts.units.bpm')}`
    case 'milliseconds': return `${formatNumber(value, figure.precision, language, absent)} ${t('charts.units.milliseconds')}`
    case 'breaths_per_minute': return `${formatNumber(value, figure.precision, language, absent)} ${t('recovery.units.breathsPerMinuteShort')}`
    case 'celsius': return `${formatNumber(value, figure.precision, language, absent)} ${t('charts.units.celsius')}`
    case 'count': return formatNumber(value, figure.precision, language, absent)
    default: return formatNumber(value, figure.precision, language, absent)
  }
}

/**
 * How a figure compares with its own usual, worded the way the glance's `usualLine` already words a
 * GlanceFigure (pages/dashboard/glanceText.ts) - this is that same rule over a PageFigure, whose
 * `standing` alone (rather than a `partial` flag of its own) carries the fact a glance figure keeps
 * in two fields. The server already decided baseline, standing and judged; this only puts them into
 * words, never computes a verdict of its own (constraints.md's "the server judges; the web renders").
 *
 * A thin baseline outranks everything, as it does for the glance: too little history to say what is
 * usual is true regardless of where the value sits. `standing === null` with a baseline that is NOT
 * thin is a running day the server declined to judge as a whole (pageFigure.ts's `standingOf`:
 * `null` on `value === null`, `baseline === null`, a thin baseline, or `partial` - the last is the
 * only way to reach here with a real, non-thin baseline), which reads as "so far" against the
 * baseline's center, never as a shortfall.
 */
export function verdictLine(figure: PageFigure, language: string, t: Translate): string | null {
  if (figure.value === null || figure.baseline === null) return null
  const { baseline } = figure
  if (baseline.thin) return t('glance.usual.thin')
  if (figure.standing === null) {
    return t('glance.usual.partial', { center: formatFigureValue(figure, baseline.center, language, t) })
  }
  const low = formatFigureValue(figure, baseline.low, language, t)
  const high = formatFigureValue(figure, baseline.high, language, t)
  if (figure.standing === 'below') return t('glance.usual.below', { low, high })
  if (figure.standing === 'above') return t('glance.usual.above', { low, high })
  return t('glance.usual.within', { low, high })
}

/**
 * A figure's own strip, in the shape a sparkline draws: each day's value, a label for it, and the
 * per-day usual bands `stripBands` already computes for the dashboard's own strips (undefined when
 * no day in it has a real, non-thin band to shade). Null when the figure carries no strip at all -
 * the server sends one only for the figures the page draws a strip under (pageFigureOf's own
 * `withStrip` flag).
 */
export function stripOf(
  figure: PageFigure,
): { values: (number | null)[], labels: string[], bands: ({ low: number, high: number } | null)[] | undefined } | null {
  if (figure.strip === null) return null
  return {
    values: figure.strip.map((day) => day.value),
    labels: figure.strip.map((day) => day.localDate),
    bands: stripBands(figure.strip),
  }
}
