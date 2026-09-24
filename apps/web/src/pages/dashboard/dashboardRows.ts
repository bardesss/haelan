import type { Glance } from '../../data/useGlance.js'

export type DashCardKind = 'night' | 'recovery' | 'today' | 'week'
export interface DashCardSlot { kind: DashCardKind, span: 4 | 8 | 12, wide: boolean }

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
 * Every row sums to twelve. The nothing-at-all case is the page's EmptyState and never reaches here.
 */
export function dashboardRows(glance: Glance): DashCardSlot[][] {
  const night = glance.sleep !== null
  const recovery = hasRecovery(glance)
  const top: DashCardSlot[] = night && recovery
    ? [{ kind: 'night', span: 8, wide: false }, { kind: 'recovery', span: 4, wide: false }]
    : night ? [{ kind: 'night', span: 12, wide: false }]
      : [{ kind: 'recovery', span: 12, wide: true }]
  const bottom: DashCardSlot[] = hasWeek(glance)
    ? [{ kind: 'today', span: 8, wide: false }, { kind: 'week', span: 4, wide: false }]
    : [{ kind: 'today', span: 12, wide: false }]
  return [top, bottom]
}
