import type { ChartTokens } from './tokens.js'

export type Night = { date: string; bed: number | null; wake: number | null; naps: number[] }

export type NightMark =
  | { kind: 'no-data'; color: string }
  | { kind: 'span'; bed: number; wake: number; color: string }

// The one place that decides whether a night reads as a sleep span or as an
// absence. Pulled out of the renderItem closure so a regression back to
// "draw nothing" for missing data is a test failure, not a silent gap.
export function nightMark(night: Night, t: ChartTokens): NightMark {
  if (night.bed === null || night.wake === null) return { kind: 'no-data', color: t.noData }
  return { kind: 'span', bed: night.bed, wake: night.wake, color: t.stageLight }
}
