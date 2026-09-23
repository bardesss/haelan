import type { Night } from './useNights.js'
import type { Stage } from '../fixtures/july.js'
import { ALL_SOURCES } from '../controls/source.js'
import { oneNightPerDate } from '@haelan/core/nights'

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

// The rule itself moved to core for M9, so the glance payload and this file cannot disagree
// about which night a date means. Re-exported so every existing import keeps working.
export { oneNightPerDate } from '@haelan/core/nights'

/**
 * Which of a date's nights this page draws.
 *
 * The route answers one row per (localDate, sourceId), and a date can hold two. A reader who named
 * a source gets that source's night or nothing at all - never another device's, because silently
 * answering a different question is the same failure the workout page's trace rule exists to
 * prevent. With no source named, the longer recording wins, which is oneNightPerDate's rule and the
 * same one the hypnogram on Sleep has always applied.
 */
export function nightFor(items: readonly Night[], source: string): Night | null {
  if (source !== ALL_SOURCES) return items.find((night) => night.sourceId === source) ?? null
  return oneNightPerDate(items)[0] ?? null
}
