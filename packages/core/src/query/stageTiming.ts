// When a night's stages arrived: how long after falling asleep the first deep and the first REM
// sleep began, and how many REM episodes the night held. Read from the night's own segments, so a
// classic recording (ASLEEP/RESTLESS, no stages) has nothing to say and says nothing.
import { ASLEEP_STAGES } from '../derive/sleep.ts'

export interface StageTimingValues { firstDeepMinutes: number | null, firstRemMinutes: number | null, cycles: number | null }

/** REM segments closer together than this are one episode; a gap at least this long starts the next. */
export const REM_EPISODE_GAP_MINUTES = 20

const MINUTE_MS = 60_000
const NONE: StageTimingValues = { firstDeepMinutes: null, firstRemMinutes: null, cycles: null }

/**
 * From a night's segments: minutes from the first asleep segment's start to the first DEEP / REM
 * start; cycles = REM episodes, a new episode starting after at least REM_EPISODE_GAP_MINUTES
 * without REM. All null when the night has no DEEP or REM segment at all (a classic recording).
 */
export function stageTimingOf(segments: readonly { stage: string, startMs: number, endMs: number }[]): StageTimingValues {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs)
  const onset = ordered.find((s) => ASLEEP_STAGES.includes(s.stage))
  const deep = ordered.find((s) => s.stage === 'DEEP')
  const rems = ordered.filter((s) => s.stage === 'REM')
  // A classic night needs no guard of its own: with no DEEP and no REM segment every value below
  // comes out null. Only a night with nothing asleep in it at all has no onset to measure from.
  if (onset === undefined) return NONE
  const since = (s: { startMs: number } | undefined) => (s === undefined ? null : (s.startMs - onset.startMs) / MINUTE_MS)
  let cycles = 0
  let lastEnd: number | null = null
  for (const rem of rems) {
    if (lastEnd === null || rem.startMs - lastEnd >= REM_EPISODE_GAP_MINUTES * MINUTE_MS) cycles += 1
    lastEnd = Math.max(lastEnd ?? rem.endMs, rem.endMs)
  }
  return { firstDeepMinutes: since(deep), firstRemMinutes: since(rems[0]), cycles: rems.length === 0 ? null : cycles }
}
