import type { Priority } from './priority.ts'
import type { SessionLike } from './overrides.ts'

/**
 * Two sessions of the same kind are one event when they overlap enough. Master design section 9:
 * priority selects the primary, and the alternate is retained rather than deleted.
 *
 * Nothing is persisted. Section 9's closing line says merges are computed rather than stored, and
 * the untouched `sessions` rows are already what "retained" means. M2c is the first caller.
 */

export const DEFAULT_OVERLAP_RATIO = 0.5

export interface SessionGroup {
  primary: SessionLike
  alternates: SessionLike[]
}

export interface GroupSessionsInput {
  sessions: readonly SessionLike[]
  /** Asked with the session kind as the metric, so sleep and exercise can rank differently. */
  priority: Priority
  overlapRatio: number
}

export function groupSessions(input: GroupSessionsInput): SessionGroup[] {
  // Sorted first so the grouping never depends on the order rows came back in.
  const sessions = [...input.sessions].sort((a, b) => (
    a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ))

  // Single linkage: if a overlaps b enough and b overlaps c enough, all three are one event even
  // where a and c barely touch. One stretch of sleep is one event however the devices cut it up.
  const parent = sessions.map((_, at) => at)
  const find = (at: number): number => {
    let root = at
    while (parent[root] !== root) root = parent[root]!
    return root
  }
  const union = (a: number, b: number) => { parent[find(a)] = find(b) }

  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const left = sessions[i]!
      const right = sessions[j]!
      if (left.kind !== right.kind) continue
      if (overlaps(left, right, input.overlapRatio)) union(i, j)
    }
  }

  const byRoot = new Map<number, SessionLike[]>()
  sessions.forEach((session, at) => {
    const root = find(at)
    const bucket = byRoot.get(root)
    if (bucket) bucket.push(session)
    else byRoot.set(root, [session])
  })

  const groups: SessionGroup[] = []
  for (const members of byRoot.values()) {
    const ordered = [...members].sort((a, b) => (
      input.priority.rank(a.kind, a.sourceId) - input.priority.rank(b.kind, b.sourceId)
      || a.startMs - b.startMs
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ))
    groups.push({ primary: ordered[0]!, alternates: ordered.slice(1) })
  }

  return groups.sort((a, b) => (
    a.primary.startMs - b.primary.startMs
    || (a.primary.id < b.primary.id ? -1 : a.primary.id > b.primary.id ? 1 : 0)
  ))
}

function overlaps(a: SessionLike, b: SessionLike, ratio: number): boolean {
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
  // A zero length session has no duration to be a fraction of, so it never joins anything.
  if (shorter <= 0) return false
  const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
  // Exceeds, not meets: section 9 says the overlap has to exceed the threshold.
  return shared > ratio * shorter
}
