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
  // The person's today, clamped into [from, to]. Equal to `today` while the period is still in
  // progress, `to` itself once the whole period has already finished, and `from` if the period has
  // not started yet. A baseline anchored on a date that has not happened has nothing behind it,
  // which is the case this exists for (`to` is a Month or Year view's calendar end, not the last
  // day anything could have happened), but the floor at `from` matters just as much as the cap at
  // `today`: useInsight sends this value as one end of a `from`/`to` pair, and requireRange in
  // packages/core/src/query/personQuery.ts refuses any request where `from` is after `to`. A cap
  // with no floor inverted into exactly that refusal the moment a period lay entirely in the
  // future (the stepper in ControlRow.tsx, or a hand typed date, reaches one in a single step) --
  // `from` was left at the period's own start while this value fell back to today, behind it.
  // Baseline calls send only this value, never `from`, so they were never at risk of that
  // inversion, but landing on `from` there is still the right answer, not merely a safe one: a
  // period that has not started has no history of its own to anchor on either, and the existing
  // thin/insufficient branches already say so honestly once the request comes back. `from` is
  // never adjusted this way itself: the series window is allowed to reach into the future (it
  // just draws no points there), and narrowing it would change what every chart on the range
  // actually shows.
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
    // Lexicographic comparison is exact here: every side is YYYY-MM-DD, the one shape every local
    // date in this system has, so string order and calendar order agree. from <= to always (see
    // datesFor), so clamping today to at most `to` and at least `from`, in either order, lands on
    // the same value; capping first reads closer to "today, unless the period has already ended".
    historicalTo: today > to ? to : today < from ? from : today,
    // A tab change is a place the reader can go back from, so it pushes. A stepper click is not.
    setTab: (tab) => { go({ range: tab }, false) },
    setAnchor: (anchor) => { go({ on: anchor }, true) },
    step: (direction) => { go({ on: stepAnchor(controls.tab, controls.anchor, direction) }, true) },
    setSource: (source) => { go({ source }, false) },
  }
}
