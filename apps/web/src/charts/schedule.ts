import type { ChartTokens } from './tokens.js'

export type Night = { date: string; bed: number | null; wake: number | null; naps: number[] }

export type NightMark =
  | { kind: 'no-data'; color: string }
  | { kind: 'span'; bed: number; wake: number; color: string }

export function nightMark(night: Night, t: ChartTokens): NightMark {
  if (night.bed === null || night.wake === null) return { kind: 'no-data', color: t.noData }
  return { kind: 'span', bed: night.bed, wake: night.wake, color: t.stageLight }
}
