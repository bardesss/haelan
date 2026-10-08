// The recovery index as a period figure, shared by the Sleep mornings and the Recovery overview.
import type { PersonQuery } from './personQuery.ts'
import { RECOVERY_USUAL_BAND, recoveryIndexSeries } from '../api/recoveryIndex.ts'
import type { RecoveryIndexAvailable } from '../api/recoveryIndex.ts'
import { BASELINE_WINDOW_DAYS } from './baseline.ts'
import type { Baseline } from './baseline.ts'
import { readRecoveryInput } from './recoveryInput.ts'
import { datesIn, minDate } from './periodBounds.ts'
import type { DateSpan, PeriodRange } from './periodBounds.ts'
import type { PeriodFigure } from './periodFigure.ts'
import { valuesFigure } from './periodRead.ts'

/**
 * The index's daily usual as the Baseline shape periodFigureOf judges days against: centre ± spread
 * = RECOVERY_USUAL_BAND, never thin.
 *
 * The index is already a distance from the person's own baselines, so a baseline drawn from its own
 * past days would be a baseline of a baseline. Its usual is instead the band `bandOf` calls usual,
 * the same on every day, and it stands on a full window because every score behind it did.
 */
export function recoveryUsualBaseline(): Baseline {
  const { low, high } = RECOVERY_USUAL_BAND
  return { center: (low + high) / 2, spread: (high - low) / 2, n: BASELINE_WINDOW_DAYS, thin: false }
}

export interface RecoveryIndexRead {
  figure: PeriodFigure
  /** Every scored day in the read span, for the tap panel and carriedBy. */
  scores: Map<string, RecoveryIndexAvailable>
}

/**
 * The index over a period, scored from merged rows whatever source a page is narrowed to, as the
 * glance scores it: there is no source parameter on purpose.
 */
export function recoveryIndexFigure(q: PersonQuery, o: {
  range: PeriodRange, anchor: string, bounds: DateSpan, span: DateSpan, lastDay: string
}): RecoveryIndexRead {
  const { range, anchor, bounds, span, lastDay } = o
  const read = { from: span.from, to: lastDay }
  const series = recoveryIndexSeries(readRecoveryInput(q, read).input, read)
  const scores = new Map([...series].flatMap(([date, day]) => (day.enough ? [[date, day] as const] : [])))
  const end = minDate(bounds.to, lastDay)
  const band = recoveryUsualBaseline()
  const dailyBands = new Map(end < bounds.from ? [] : datesIn({ from: bounds.from, to: end }).map((date) => [date, band] as const))
  const figure = valuesFigure({
    metric: 'recovery_index', unit: 'score', precision: 0, direction: 'up', range, anchor, bounds, lastDay,
    values: new Map([...scores].map(([date, day]) => [date, day.score] as const)), dailyBands, additive: false,
  })
  return { figure, scores }
}
