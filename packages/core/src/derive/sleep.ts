import type { DailyRow } from './rollup.ts'
import { DERIVATION_VERSION } from './version.ts'

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

export interface SleepSegmentLike {
  sessionId: string
  stage: string
  startMs: number
  endMs: number
}

/**
 * The measured values of `sleep.stages[].type`, in probe/findings/field-map.md. A value outside
 * this set counts toward neither asleep nor awake: calling it asleep would inflate the night and
 * calling it awake would deflate it, and inventing either is worse than reporting what we know.
 */
export const ASLEEP_STAGES: readonly string[] = ['DEEP', 'LIGHT', 'REM']
export const AWAKE_STAGE = 'AWAKE'

/**
 * A day's sleep sessions and their segments to `daily` rows, for one source.
 *
 * Every figure is summed from the segments rather than read from the provider's own summary.
 * A number we computed can be inspected against the rows underneath it, and it moves when an
 * override excludes a session, which a copied figure never would.
 */
export function deriveSleepDay(input: {
  personId: string
  localDate: string
  source: string
  sessions: readonly SleepSessionLike[]
  segments: readonly SleepSegmentLike[]
  gapMinutes: number
}): DailyRow[] {
  if (input.sessions.length === 0) return []

  const { night, naps } = assembleNights({ sessions: input.sessions, gapMinutes: input.gapMinutes })
  const out: DailyRow[] = []
  const push = (metric: string, agg: DailyRow['agg'], value: number | null) => {
    if (value === null) return
    out.push({
      personId: input.personId,
      localDate: input.localDate,
      metric,
      agg,
      source: input.source,
      value,
      // A night has no samples underneath it, so the fraction of the day's hours carrying one is
      // not a question this row can answer. M2d decides what a null coverage means.
      coverage: null,
      sourceMix: null,
      derivationVersion: DERIVATION_VERSION,
    })
  }

  if (night.length > 0) {
    const start = Math.min(...night.map((s) => s.startMs))
    const end = Math.max(...night.map((s) => s.endMs))
    const first = night.find((s) => s.startMs === start)!
    const last = night.find((s) => s.endMs === end)!
    const inBed = minutesBetween(start, end)

    push('sleep_in_bed_minutes', 'sum', inBed)
    push('sleep_bedtime_minutes', 'last', localMinutesOf(input.localDate, first.startMs, first.startOffsetMinutes))
    push('sleep_waketime_minutes', 'last', localMinutesOf(input.localDate, last.endMs, last.endOffsetMinutes))

    const ids = new Set(night.map((s) => s.id))
    const staged = input.segments.filter((seg) => ids.has(seg.sessionId))
    // No segments is not zero segments: the staging can fail, which attrs.stagesStatus reports,
    // and a zero here would claim the person lay awake all night.
    if (staged.length > 0) {
      const byStage = (stage: string) => staged
        .filter((seg) => seg.stage === stage)
        .reduce((total, seg) => total + minutesBetween(seg.startMs, seg.endMs), 0)

      const deep = byStage('DEEP')
      const light = byStage('LIGHT')
      const rem = byStage('REM')
      const asleep = deep + light + rem
      // The time between two pieces is time out of bed, and it counts against the night exactly
      // as an AWAKE stage inside one session does.
      const awake = byStage(AWAKE_STAGE) + gapMinutesWithin(night)

      push('sleep_deep_minutes', 'sum', deep)
      push('sleep_light_minutes', 'sum', light)
      push('sleep_rem_minutes', 'sum', rem)
      push('sleep_asleep_minutes', 'sum', asleep)
      push('sleep_awake_minutes', 'sum', awake)
      push('sleep_efficiency', 'last', inBed > 0 ? Math.round((asleep / inBed) * 100) : null)
    }
  }

  // Zero naps is a measurement rather than a gap: we looked and there were none. A day with no
  // sleep at all returned above, before reaching here.
  push('sleep_nap_count', 'count', naps.length)
  push('sleep_nap_minutes', 'sum', naps.reduce((total, s) => total + minutesBetween(s.startMs, s.endMs), 0))

  return out
}

const minutesBetween = (fromMs: number, toMs: number): number => Math.round((toMs - fromMs) / MINUTE_MS)

/** Minutes from the local midnight of `localDate`, negative before it. */
function localMinutesOf(localDate: string, utcMs: number, offsetMinutes: number): number {
  const wall = utcMs + offsetMinutes * MINUTE_MS
  return Math.round((wall - Date.parse(`${localDate}T00:00:00Z`)) / MINUTE_MS)
}

/** The time between consecutive pieces of one night, which nobody was in bed for. */
function gapMinutesWithin(night: readonly SleepSessionLike[]): number {
  const ordered = [...night].sort((a, b) => a.startMs - b.startMs)
  let total = 0
  for (let i = 1; i < ordered.length; i += 1) {
    const previousEnd = Math.max(...ordered.slice(0, i).map((s) => s.endMs))
    // Negative for a piece that overlaps the one before it, which contributes no gap at all.
    total += Math.max(0, minutesBetween(previousEnd, ordered[i]!.startMs))
  }
  return total
}
