import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { useSession } from '../auth/session.js'
import { sourceActivityKey } from './useSourceNames.js'
import type { NamedSourceWithActivity } from './useSourceNames.js'
import type { SeriesPoint } from './useSeries.js'
import { sourcesIn } from './pageShell.js'

/**
 * Which sources have gone quiet, for a card to say so beside its own title.
 *
 * The judgement is the server's (`status: 'stale'` off `/sources?activity=1`, packages/core's
 * sourceCadence.ts): a source silent for more than four of its own median gaps, floored at 14
 * days. Not recomputed here from the points a card holds, for two reasons. A card's points are
 * one range, and the rule needs 14 reporting dates of history, so a Week view could never judge
 * anything. And a second copy of the thresholds in the browser is how the two would come to
 * disagree about the same source on the same day - the reason the settings card reads the server
 * too.
 *
 * The request costs 19-60ms against a real archive, which is why useSourceNames keeps it off the
 * hot path. It is paid here once and then cached for five minutes across every page, under the
 * settings card's own key, so browsing between pages does not ask again and a rename (which
 * invalidates that key) still refreshes it.
 */
export interface StaleSource {
  sourceId: string
  name: string
  lastReportedDate: string
  medianGapDays: number | null
}

interface StaleSourcesValue {
  stale: ReadonlyMap<string, StaleSource>
  rangeEnd: string
}

const StaleSourcesContext = createContext<StaleSourcesValue | null>(null)

const FIVE_MINUTES = 5 * 60_000

/**
 * Wraps a page's cards. `rangeEnd` is the last day the page is showing: a source only warns on a
 * card when it went quiet before that day, so looking back at July never warns about a watch that
 * died in August, and looking at August does.
 */
export function StaleSourcesProvider({ rangeEnd, children }: { rangeEnd: string, children: ReactNode }) {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: sourceActivityKey(personId ?? ''),
    enabled: personId !== undefined,
    staleTime: FIVE_MINUTES,
    queryFn: () => apiGet<{ items: NamedSourceWithActivity[] }>(`/api/v1/p/${personId!}/sources?activity=1`),
  })
  const items = query.data?.items
  const value = useMemo<StaleSourcesValue>(() => {
    const stale = new Map<string, StaleSource>()
    for (const item of items ?? []) {
      if (item.status !== 'stale' || item.lastReportedDate === null) continue
      // Its data kept arriving under another source id, so no card is missing anything and a
      // warning would tell the reader a working watch had stopped (packages/core's
      // sourceActivity.ts). A response without the field reads as false, which is the old
      // behaviour: a warning.
      if (item.continuedElsewhere) continue
      stale.set(item.id, { sourceId: item.id, name: item.name, lastReportedDate: item.lastReportedDate, medianGapDays: item.medianGapDays })
    }
    return { stale, rangeEnd }
  }, [items, rangeEnd])
  return <StaleSourcesContext.Provider value={value}>{children}</StaleSourcesContext.Provider>
}

/**
 * The stale sources that fed these points and went quiet before the end of the range on screen.
 *
 * A point names its sources through `sourceMix` on a merged row, or through `source` itself when
 * the reader picked one device. Outside a provider - a card in a test, a page that has not adopted
 * this - the answer is always empty, so nothing changes for it. A failed or pending request is
 * empty too: a missing warning is the old behaviour, a wrong one would be new.
 */
export function useStaleSourcesFor(points: readonly SeriesPoint[]): StaleSource[] {
  const context = useContext(StaleSourcesContext)
  return useMemo(() => {
    if (context === null || context.stale.size === 0) return []
    const feeding = new Set<string>()
    for (const point of points) {
      const mix = sourcesIn(point.sourceMix)
      if (mix.length > 0) for (const source of mix) feeding.add(source)
      else feeding.add(point.source)
    }
    return [...feeding]
      .map((id) => context.stale.get(id))
      .filter((source): source is StaleSource => source !== undefined && source.lastReportedDate < context.rangeEnd)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [context, points])
}
