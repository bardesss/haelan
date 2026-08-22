/**
 * Which source wins, per metric. Master design section 9: merging happens at derivation from a
 * per metric priority list the user configures, and never on write.
 *
 * Pure and synchronous. The store loads the lists, this decides what they mean, and mergeDay
 * asks one question at a time. Keeping the rule here rather than in the store is what lets the
 * merge be property tested without a database.
 */

export interface SourceFacts {
  id: string
  kind: 'device' | 'app' | 'manual'
}

export interface PriorityInput {
  /** Metric name, or DEFAULT_LIST, to source ids best first. */
  lists: ReadonlyMap<string, readonly string[]>
  /** Every source the person has, which is what the fallback orders. */
  sources: readonly SourceFacts[]
}

export interface Priority {
  /** Lower wins. Zero is best. */
  rank(metric: string, sourceId: string): number
}

/** The metric key of the person's default list, used by every metric without a list of its own. */
export const DEFAULT_LIST = '*'

/**
 * Where unconfigured sources start. Far above any plausible list length, so a configured source
 * always outranks an unconfigured one without the two orderings having to interleave.
 */
export const UNRANKED_BASE = 1_000_000

// A device measured it, an app relayed it, a person typed it. Manual last is a default and not a
// judgement: whoever's scale lies and whose typed weights are true reorders the list.
const KIND_ORDER: Record<SourceFacts['kind'], number> = { device: 0, app: 1, manual: 2 }

/**
 * The order used where nothing is configured. It has to survive M2e's rebuild unchanged, which
 * is why the tie-break is the source id, derived from person and externalId, rather than
 * created_at_ms, which a rebuild re-stamps.
 */
export function fallbackOrder(sources: readonly SourceFacts[]): string[] {
  return [...sources]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => s.id)
}

export function priorityFrom(input: PriorityInput): Priority {
  const fallback = new Map(fallbackOrder(input.sources).map((id, at) => [id, at]))

  return {
    rank(metric, sourceId) {
      // A metric's own list is a complete statement for that metric. It does not fall through to
      // the default for a source it omits, because the two lists' indices are not comparable.
      const list = input.lists.get(metric) ?? input.lists.get(DEFAULT_LIST)
      const at = list ? list.indexOf(sourceId) : -1
      if (at >= 0) return at
      // A source with no facts sorts last rather than throwing: it can appear in a day's rows
      // before anything registered it.
      return UNRANKED_BASE + (fallback.get(sourceId) ?? input.sources.length)
    },
  }
}
