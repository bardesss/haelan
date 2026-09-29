import type { PageFigure } from '../../../data/useNightPage.js'
import { formatClock, formatDuration, formatNumber, formatSignedNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { stripBands } from '../../dashboard/cardShared.js'
import type { PointStanding } from '../../../charts/base.js'

// Figures measured in minutes that are only ever a few of them: "12 min" reads as what it is,
// where "0h 12m" puts an empty hour in front of it. Time asleep, the stages, time in bed and time
// awake stay durations, since those do run to hours.
const SHORT_SPANS: ReadonlySet<string> = new Set([
  'active_minutes', 'sleep_latency_minutes', 'sleep_after_wake_minutes', 'sleep_bedtime_variability',
])

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
    case 'minutes': return SHORT_SPANS.has(figure.metric)
      ? `${formatNumber(value, 0, language, absent)} ${t('activity.units.min')}`
      : formatDuration(value)
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
  // A clock time off its usual is later or earlier, the words the dashboard's night card uses for
  // a bedtime or wake time (glance.sleep.bedStanding): "above your usual 22:44 – 01:35" asks the
  // reader to work out that a higher clock reading is a later night.
  const clock = figure.unit === 'minutes_from_local_midnight' && figure.standing !== 'within'
  // A usual with no width (every night of the window read the same, say no naps at all) is one
  // value, and "0 – 0" reads as a typo for it.
  if (low === high) return t(`sleep.night.${clock ? 'clockSingle' : 'usualSingle'}.${figure.standing}`, { value: low })
  if (clock) return t(`sleep.night.clockUsual.${figure.standing}`, { low, high })
  if (figure.standing === 'below') return t('glance.usual.below', { low, high })
  if (figure.standing === 'above') return t('glance.usual.above', { low, high })
  return t('glance.usual.within', { low, high })
}

/**
 * Skin temperature's usual, worded as the deviation its value is printed as: the band's edges less
 * its centre, signed, so "+0.6 °C" sits beside "above your usual ±0.3 °C" rather than beside an
 * absolute "32.7 °C – 33.3 °C" the reader has to subtract for themselves. An even band reads as
 * one "±" figure, an uneven one as its two signed edges. A thin usual and a day the server did not
 * judge word themselves exactly as verdictLine words them, since neither names a range.
 */
export function deviationVerdictLine(figure: PageFigure, language: string, t: Translate): string | null {
  const { baseline, standing } = figure
  if (figure.value === null || baseline === null || baseline.thin || standing === null) return verdictLine(figure, language, t)
  const unit = t('charts.units.celsius')
  const absent = t('common.absent')
  const low = formatSignedNumber(baseline.low - baseline.center, figure.precision, language, absent)
  const high = formatSignedNumber(baseline.high - baseline.center, figure.precision, language, absent)
  const range = low.replace(/^-/, '') === high.replace(/^\+/, '')
    ? `±${high.replace(/^\+/, '')} ${unit}`
    : `${low} ${unit} – ${high} ${unit}`
  return t(`sleep.night.deviation.${standing}`, { range })
}

/**
 * A figure's own strip, in the shape a sparkline draws: each day's value, a label for it, where
 * the server said that day stood (so a day outside its usual takes the warning colour), and the
 * per-day usual bands `stripBands` already computes for the dashboard's own strips (undefined when
 * no day in it has a real, non-thin band to shade). Null when the figure carries no strip at all -
 * the server sends one only for the figures the page draws a strip under (pageFigureOf's own
 * `withStrip` flag) - and null too below two readings, since one dot joins nothing and every
 * caller then falls back to its bar.
 */
export function stripOf(figure: PageFigure): {
  values: (number | null)[], labels: string[], pointStandings: PointStanding[]
  bands: ({ low: number, high: number } | null)[] | undefined
} | null {
  if (figure.strip === null) return null
  if (figure.strip.filter((day) => day.value !== null).length < 2) return null
  return {
    values: figure.strip.map((day) => day.value),
    labels: figure.strip.map((day) => day.localDate),
    pointStandings: figure.strip.map((day) => day.standing),
    bands: stripBands(figure.strip),
  }
}
