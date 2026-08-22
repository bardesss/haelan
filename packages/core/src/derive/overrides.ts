import { parseDayMetricTarget, parseSampleTarget, parseSessionTarget, sampleTarget } from './targetKey.ts'
import type { OverrideScope } from './targetKey.ts'
import type { DailyRow, SampleLike } from './rollup.ts'

/**
 * Corrections applied at derivation, never on write. Master design: a glitching strap reporting
 * 210 bpm is excluded here, the raw payload is never modified, and removing the override
 * restores the original value exactly because the original value was never overwritten.
 */

export interface OverrideLike {
  scope: OverrideScope
  targetKey: string
  action: 'exclude' | 'correct'
  correctedValue: number | null
}

export interface SessionLike {
  id: string
  sourceId: string
  kind: string
  startMs: number
  endMs: number
}

export function applyToSamples(
  rows: readonly SampleLike[],
  overrides: readonly OverrideLike[],
): SampleLike[] {
  const bySample = new Map<string, OverrideLike>()
  for (const override of overrides) {
    if (override.scope !== 'sample') continue
    // Parsed and re-encoded rather than trusted as written: a key that came from somewhere other
    // than the builders would silently match nothing.
    bySample.set(sampleTarget(parseSampleTarget(override.targetKey)), override)
  }
  if (bySample.size === 0) return [...rows]

  const out: SampleLike[] = []
  for (const row of rows) {
    const override = bySample.get(
      sampleTarget({ source: row.sourceId, metric: row.metric, utcMs: row.utcMs }),
    )
    if (!override) { out.push(row); continue }
    if (override.action === 'exclude') continue
    // Every aggregate of the minute takes the corrected reading, for the same reason the key
    // carries no agg: the person corrected a reading, not one of its three summaries.
    out.push({ ...row, value: override.correctedValue })
  }
  return out
}

/** Which metrics this local day has been thrown out for. */
export function excludedMetrics(
  overrides: readonly OverrideLike[],
  localDate: string,
): Set<string> {
  const out = new Set<string>()
  for (const override of overrides) {
    if (override.scope !== 'day_metric' || override.action !== 'exclude') continue
    const target = parseDayMetricTarget(override.targetKey)
    if (target.localDate === localDate) out.add(target.metric)
  }
  return out
}

/**
 * Every source and every aggregate, merged rows included. A day somebody threw out is thrown
 * out: leaving the merged row would put the number back on the chart the exclusion was made from.
 */
export function applyToDay(
  rows: readonly DailyRow[],
  excluded: ReadonlySet<string>,
): DailyRow[] {
  if (excluded.size === 0) return [...rows]
  return rows.filter((row) => !excluded.has(row.metric))
}

export interface SessionOverrideResult {
  kept: SessionLike[]
  /** Session id to corrected value, for M2c. Nothing in M2b has a value to replace. */
  corrections: Map<string, number>
}

export function applyToSessions(
  sessions: readonly SessionLike[],
  overrides: readonly OverrideLike[],
): SessionOverrideResult {
  const excluded = new Set<string>()
  const corrections = new Map<string, number>()
  for (const override of overrides) {
    if (override.scope !== 'session') continue
    const id = parseSessionTarget(override.targetKey)
    if (override.action === 'exclude') excluded.add(id)
    else if (override.correctedValue !== null) corrections.set(id, override.correctedValue)
  }
  return { kept: sessions.filter((s) => !excluded.has(s.id)), corrections }
}
