/**
 * Sleep, from sessions and their stage segments to a day's figures.
 *
 * Three different things merge sleep, and confusing them is how a night goes missing:
 *
 *   groupSessions, in sessionOverlap.ts, merges one event recorded by two SOURCES
 *   assembleNights, here, merges one night recorded as several SESSIONS
 *   shortAwakenings, carried in sessions.attrs, is the provider's model of brief wakes INSIDE
 *   one session, and nothing here touches it
 */

/** Two hours. Long enough for a real wake, short enough that an afternoon sleep stays a nap. */
export const DEFAULT_NIGHT_GAP_MINUTES = 120

export interface SleepSessionLike {
  id: string
  sourceId: string
  startMs: number
  startOffsetMinutes: number
  endMs: number
  endOffsetMinutes: number
  /** `metadata.mainSleep`, null when the source did not say. */
  mainSleep: boolean | null
}

export interface NightAssembly {
  /** The night's pieces, ordered by start. Empty when the day had no sleep at all. */
  night: SleepSessionLike[]
  /** Everything that did not join the night, ordered by start. */
  naps: SleepSessionLike[]
}

const MINUTE_MS = 60_000

/**
 * A day's sleep sessions to one night plus its naps.
 *
 * Pieces separated by at most the gap are one night. That is what makes an early wake come
 * out as the night it was rather than as a night plus a nap, which would under-report it by the
 * length of the second piece every time.
 *
 * A nap needs no rule of its own: it is a session that did not join. A long afternoon sleep is
 * correctly a nap, and a maximum length would only let one be misfiled as a night.
 */
export function assembleNights(input: {
  sessions: readonly SleepSessionLike[]
  gapMinutes: number
}): NightAssembly {
  // Sorted first, so nothing below depends on the order rows came back in.
  const ordered = [...input.sessions].sort((a, b) => (
    a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ))
  if (ordered.length === 0) return { night: [], naps: [] }

  const gapMs = input.gapMinutes * MINUTE_MS
  const groups: SleepSessionLike[][] = []
  for (const session of ordered) {
    const current = groups.at(-1)
    // Against the latest end in the group rather than the previous session's, so a short piece
    // nested inside a longer one cannot break the chain.
    const latestEnd = current ? Math.max(...current.map((s) => s.endMs)) : null
    if (current && latestEnd !== null && session.startMs - latestEnd <= gapMs) current.push(session)
    else groups.push([session])
  }

  const nightAt = pickNight(groups)
  return {
    night: groups[nightAt] ?? [],
    naps: groups.filter((_, at) => at !== nightAt).flat(),
  }
}

/**
 * Which group is the night. The provider's flag when exactly one group carries it, because it
 * knows things we do not, and the longest group otherwise. Note the flag chooses between groups
 * and never within one: a piece that joined by gap is part of the night whatever its own flag
 * says, which is the early wake case.
 */
function pickNight(groups: readonly SleepSessionLike[][]): number {
  const flagged = groups
    .map((group, at) => ({ at, flagged: group.some((s) => s.mainSleep === true) }))
    .filter((g) => g.flagged)
  if (flagged.length === 1) return flagged[0]!.at

  let best = 0
  let bestSpan = -1
  groups.forEach((group, at) => {
    const span = spanOf(group)
    // Strictly greater, so an equal span keeps the earlier group and the answer stays the same
    // whatever order the groups were built in.
    if (span > bestSpan) { bestSpan = span; best = at }
  })
  return best
}

function spanOf(group: readonly SleepSessionLike[]): number {
  return Math.max(...group.map((s) => s.endMs)) - Math.min(...group.map((s) => s.startMs))
}
