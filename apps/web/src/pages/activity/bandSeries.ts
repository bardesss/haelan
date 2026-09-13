import type { BandSeries } from '../../charts/StackedDailyBars.js'

/**
 * The four bands, from the six metrics that describe them.
 *
 * Activity levels and heart rate zones count the same clock minutes - measured in
 * probe/findings/activity-minute-overlap.md - so stacking them raw double counts, and the peak
 * band drawn beside vigorous is the same minutes drawn twice. Subtracting each level's own overlap
 * and summing the overlaps for peak makes the four a partition: every active minute lands in
 * exactly one band whatever its zone, and the total is the count of distinct active minutes.
 *
 * A peak minute is subtracted from the level that carried it, not from vigorous by assumption.
 * The archive showed every peak minute was vigorous, but it also showed light minutes in the
 * cardio zone, so the two vocabularies are not nested and the assumption has no guarantee behind
 * it.
 */

const LEVELS = [
  { key: 'light', level: 'active_minutes_light', overlap: 'active_minutes_light_peak' },
  { key: 'moderate', level: 'active_minutes_moderate', overlap: 'active_minutes_moderate_peak' },
  { key: 'vigorous', level: 'active_minutes_vigorous', overlap: 'active_minutes_vigorous_peak' },
] as const

type Dense = ReadonlyMap<string, { values: (number | null)[], labels: string[] }>

export function bandSeries(dense: Dense, name: (key: string) => string = (key) => key): BandSeries[] {
  const days = dense.get(LEVELS[0].level)?.values.length ?? 0
  const at = (metric: string, day: number): number | null => dense.get(metric)?.values[day] ?? null

  const bands: BandSeries[] = LEVELS.map(({ key, level, overlap }) => ({
    key,
    name: name(key),
    values: Array.from({ length: days }, (_, day) => {
      const total = at(level, day)
      // A day the level never reported is a gap in this band, not a zero: see denseSeries' own
      // comment on why an excluded day has to keep a position rather than vanish.
      if (total === null) return null
      // A null overlap is no overlap. deriveActivityBandsDay writes no row for a level that never
      // met a peak minute, which is most days, and that absence means zero here rather than a gap.
      return Math.max(0, total - (at(overlap, day) ?? 0))
    }),
  }))

  bands.push({
    key: 'peak',
    name: name('peak'),
    values: Array.from({ length: days }, (_, day) => {
      const parts = LEVELS.map(({ overlap }) => at(overlap, day))
      // Peak is a gap only when every level is a gap; otherwise an absent overlap is zero.
      if (LEVELS.every(({ level }) => at(level, day) === null)) return null
      return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
    }),
  })

  return bands
}
