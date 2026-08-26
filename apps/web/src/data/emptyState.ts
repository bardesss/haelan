import type { SeriesPoint } from './useSeries.js'
import type { Baseline } from './useBaseline.js'

export type EmptyStateKind = 'no_data' | 'not_worn' | 'insufficient'

/**
 * Which of the three empty states a card should render, or null to render the data.
 *
 * The parent spec requires these read differently and that none renders as zero or as a blank
 * chart, because "no naps detected", "device not worn" and "not enough data to summarise" are
 * three different statements and only one of them is a number.
 */
export function emptyStateFor(
  points: SeriesPoint[] | undefined, baseline?: Baseline | null,
): EmptyStateKind | null {
  // Ordered strongest first. Nothing at all outranks a thin baseline: telling a reader their
  // baseline is thin implies there is a series it was thin against.
  if (points === undefined || points.length === 0) return 'no_data'

  // Zero is an answer and null is the absence of one, so this tests coverage rather than value.
  const worn = points.some((p) => p.coverage !== null && p.coverage > 0)
  if (!worn) return 'not_worn'

  if (baseline != null && baseline.thin) return 'insufficient'

  return null
}
