import { useMemo } from 'react'
import { useRoute, navigate, withQuery } from '../router.js'
import { useSession } from '../auth/session.js'
import { parseControls, datesFor, stepAnchor } from './range.js'
import type { RangeKey } from './range.js'

export interface PageControlsState {
  tab: RangeKey
  anchor: string
  source: string
  from: string
  to: string
  // `to`, unless the range reaches past today, in which case this is today instead. A baseline
  // anchored on `to` used to read the tomorrows of a Month or Year view still in progress: `to` is
  // the period's calendar end, not the last day anything could have happened, and a window or a
  // baseline anchor sitting past today has no history behind the part of itself that has not
  // happened yet. `from` is never adjusted the same way: the series window is allowed to reach
  // into the future (it just draws no points there), and narrowing it would change what every
  // chart on the range actually shows.
  historicalTo: string
  setTab: (tab: RangeKey) => void
  setAnchor: (anchor: string) => void
  step: (direction: -1 | 1) => void
  setSource: (source: string) => void
}

/**
 * The URL is the only copy of this state. Nothing here holds it in React state and nothing
 * synchronises the two, because two effects mirroring each other is the shape that produced
 * M3a's session expiry loop.
 */
export function usePageControls(): PageControlsState {
  const route = useRoute()
  const session = useSession()

  // The person's today, not the browser's. en-CA formats as YYYY-MM-DD, which is the shape every
  // local date in this system already has.
  const today = useMemo(() => {
    const timezone = session.data?.timezone
    const options: Intl.DateTimeFormatOptions = timezone === undefined ? {} : { timeZone: timezone }
    return new Intl.DateTimeFormat('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date())
  }, [session.data?.timezone])

  const search = route.includes('?') ? route.slice(route.indexOf('?')) : ''
  const controls = parseControls(search, today)
  const { from, to } = datesFor(controls.tab, controls.anchor)

  const go = (patch: Record<string, string | null>, replace: boolean) => {
    navigate(withQuery(route, patch), { replace })
  }

  return {
    ...controls,
    from,
    to,
    // Lexicographic comparison is exact here: both sides are YYYY-MM-DD, the one shape every local
    // date in this system has, so string order and calendar order agree.
    historicalTo: to < today ? to : today,
    // A tab change is a place the reader can go back from, so it pushes. A stepper click is not.
    setTab: (tab) => { go({ range: tab }, false) },
    setAnchor: (anchor) => { go({ on: anchor }, true) },
    step: (direction) => { go({ on: stepAnchor(controls.tab, controls.anchor, direction) }, true) },
    setSource: (source) => { go({ source }, false) },
  }
}
