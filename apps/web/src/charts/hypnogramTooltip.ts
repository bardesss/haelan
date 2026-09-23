import type { Stage } from '../fixtures/july.js'
import { formatClock, formatDuration } from '../format.js'
import type { Translate } from '../format.js'
import { STAGE_LABEL_KEY } from './stage.js'
import { tip } from './base.js'

const MINUTE_MS = 60_000

/**
 * One hovered sleep segment, said the way the accessible table's own row for it says it: from, to,
 * stage, duration. The table is the reason this is four values rather than two - a reader who
 * hovers and a reader who opens the table are told the same thing about the same segment.
 *
 * `index` counts into `segments` directly, unlike Sparkline's overlay marks: this chart's custom
 * series is built one entry per segment (`data: segments.map(...)` in Hypnogram.tsx) and draws no
 * markPoint or markLine at all, so there is no second array a dataIndex could belong to.
 *
 * Milliseconds in, rounded once per displayed value: the component's own `stageTotals` comment
 * records what summing pre-rounded boundaries cost this project (1,568 invented minutes across one
 * household's history), and nothing here sums anything, so each cell rounds independently exactly
 * as the table's cells do.
 */
export function hypnogramTooltip(
  segments: readonly { stage: Stage; startMs: number; endMs: number }[],
  index: number | undefined,
  t: Translate,
  // The night's start as a clock minute (Hypnogram's `startClock`): with it, from and to are clock
  // times, matching the axis and the table; without it, elapsed time since the night began.
  origin: number | null = null,
): string {
  const segment = index === undefined ? undefined : segments[index]
  if (!segment) return ''
  const at = (ms: number) => origin === null ? formatDuration(ms / MINUTE_MS) : formatClock(origin + ms / MINUTE_MS)
  const span = t('charts.hypnogramTooltip.span', { from: at(segment.startMs), to: at(segment.endMs) })
  const stage = t('charts.tooltip.line', {
    label: t(STAGE_LABEL_KEY[segment.stage]),
    value: formatDuration((segment.endMs - segment.startMs) / MINUTE_MS),
  })
  return tip`${span}<br/>${stage}`
}
