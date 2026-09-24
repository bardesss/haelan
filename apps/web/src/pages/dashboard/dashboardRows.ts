import type { Glance } from '../../data/useGlance.js'

// One variant per kind, each with only the spans its card takes, so the page hands `slot.span`
// straight to the card's own prop without a cast. `wide` is on every variant (false outside
// recovery) so a reader of the rows can ask it of any slot.
export type DashCardSlot =
  | { kind: 'night', span: 8 | 12, wide: false }
  | { kind: 'recovery', span: 4 | 12, wide: boolean }
  | { kind: 'today', span: 8 | 12, wide: false }
  | { kind: 'week', span: 4, wide: false }
export type DashCardKind = DashCardSlot['kind']

export function hasRecovery(glance: Glance): boolean {
  const { index, restingHeartRate, hrv } = glance.recovery
  return index.value !== null || restingHeartRate.value !== null || hrv.value !== null
}

export function hasWeek(glance: Glance): boolean {
  const { steps, activeMinutes, asleep } = glance.week
  return steps !== null || activeMinutes !== null || asleep !== null
}

/**
 * The page's rows and each card's span, decided here rather than by cards hiding themselves: a card
 * that vanished from an 8 + 4 row would leave a hole, which is the uniform-span rule's whole point.
 * Every row sums to twelve, except the top row when there is neither a night nor any recovery
 * reading: the amendment says to omit it rather than lead with an empty recovery card, and an empty
 * row contributes nothing for `flat()` to draw regardless of what it would have summed to. The
 * nothing-at-all case is the page's EmptyState and never reaches here.
 */
export function dashboardRows(glance: Glance): DashCardSlot[][] {
  const night = glance.sleep !== null
  const recovery = hasRecovery(glance)
  const top: DashCardSlot[] = night && recovery
    ? [{ kind: 'night', span: 8, wide: false }, { kind: 'recovery', span: 4, wide: false }]
    : night ? [{ kind: 'night', span: 12, wide: false }]
      : recovery ? [{ kind: 'recovery', span: 12, wide: true }]
        : []
  const bottom: DashCardSlot[] = hasWeek(glance)
    ? [{ kind: 'today', span: 8, wide: false }, { kind: 'week', span: 4, wide: false }]
    : [{ kind: 'today', span: 12, wide: false }]
  return top.length === 0 ? [bottom] : [top, bottom]
}
