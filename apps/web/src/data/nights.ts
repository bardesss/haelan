import type { Night } from './useNights.js'
import type { Stage } from '../fixtures/july.js'

// oneNightPerDate and stageOf lived, byte-identical, in Dashboard.tsx and Sleep.tsx, one copy
// each. The night detail page is a third caller, and a third copy is what makes the duplication
// worth ending rather than repeating: both moved here verbatim, comments included, from
// Dashboard.tsx.

// packages/core/src/derive/sleep.ts's ASLEEP_STAGES and AWAKE_STAGES recognise six stage values
// (DEEP, LIGHT, REM, AWAKE, ASLEEP, RESTLESS), the derive layer's `recognised` guard refusing to
// count anything outside that vocabulary toward either asleep or awake rather than guessing. This page
// draws only the four staged ones. A segment carrying ASLEEP or RESTLESS, the classic non-staged
// pair, is dropped here for the same not-guessing reason, leaving a visible gap in the hypnogram,
// rather than drawn, coloured and tabulated as LIGHT: a device reporting a value nobody staged is
// not the same case as an internal lane index falling out of range, which is the only place
// Hypnogram itself still falls back.
export function stageOf(raw: string): Stage | null {
  const known: Record<string, Stage> = { DEEP: 'deep', LIGHT: 'light', REM: 'rem', AWAKE: 'awake' }
  return known[raw] ?? null
}

// /sleep/nights returns one row per (localDate, sourceId), so two sources reporting sleep on the
// same date is two rows for what is, to a reader, one night. Collapsed to one per date with a
// stated rule rather than left to whatever order the route happens to return: the longest
// duration entry wins, since a second device capturing the same night is more likely to hold a
// shorter, partial recording than the source that actually stayed on through it.
export function oneNightPerDate(items: readonly Night[]): Night[] {
  const byDate = new Map<string, Night>()
  for (const n of items) {
    const existing = byDate.get(n.localDate)
    if (existing === undefined || (n.endMs - n.startMs) > (existing.endMs - existing.startMs)) {
      byDate.set(n.localDate, n)
    }
  }
  return [...byDate.values()].sort((a, b) => a.localDate.localeCompare(b.localDate))
}
