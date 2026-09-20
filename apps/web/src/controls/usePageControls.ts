import { useMemo } from 'react'
import { useRoute, navigate, withQuery } from '../router.js'
import { useSession } from '../auth/session.js'
import { useHistoryStart } from '../data/useHistoryStart.js'
import { parseControls, datesFor, stepAnchor, clampFromToHistory } from './range.js'
import type { RangeKey } from './range.js'
import { readRange, writeRange } from '../ui/rangePreference.js'

export interface PageControlsState {
  tab: RangeKey
  anchor: string
  source: string
  from: string
  to: string
  /**
   * The person's today, resolved from their session timezone (falling back to the browser's own
   * when a session has not loaded one yet), not the machine's UTC date. Callers that need to
   * compare "today" against a scored or fetched date - the recovery tile's `asOfLabel` is the
   * first - read this rather than computing their own: `new Date().toISOString().slice(0, 10)` is
   * the UTC date, which disagrees with this value for part of every day, and this codebase already
   * had one bug from exactly that (`historicalTo` below existed to fix it for range clamping; this
   * field exists so a caller outside that clamp never has to reach for the UTC shortcut either).
   */
  today: string
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
  // Read on every render rather than held in state, and that is the point rather than an
  // oversight. State would be the second copy this hook's doc comment forbids, and it would need
  // an effect to stay level with the URL - the exact mirroring shape that produced M3a's session
  // expiry loop. A getItem is cheap, and reading it fresh is also what makes it correct: arriving
  // on a page with no query of its own should honour whatever the reader last chose, including a
  // choice made one route change ago.
  const controls = parseControls(search, today, readRange() ?? 'month')
  const { from: tabFrom, to } = datesFor(controls.tab, controls.anchor)
  // A phone-only history starts at the first sync, not at the tab start:
  // every card on these pages reads from here, so one clamp honors the start in each
  // query and each "reported of total" denominator at once. Pending or Google-backed
  // histories leave the range alone, and the anchor, stepper and `to` never move.
  //
  // The clamp sits after the remembered range rather than before it: the range decides which
  // window the reader asked for, and this decides how much of that window the data can honestly
  // answer. Reversing them would clamp a window nobody had chosen yet.
  const history = useHistoryStart()
  const timezone = session.data?.timezone
  const from = timezone === undefined
    ? tabFrom
    : clampFromToHistory(tabFrom, to, history.data, timezone)

  const go = (patch: Record<string, string | null>, replace: boolean) => {
    navigate(withQuery(route, patch), { replace })
  }

  return {
    ...controls,
    from,
    to,
    today,
    // Lexicographic comparison is exact here: every side is YYYY-MM-DD, the one shape every local
    // date in this system has, so string order and calendar order agree. from <= to always (see
    // datesFor), so clamping today to at most `to` and at least `from`, in either order, lands on
    // the same value; capping first reads closer to "today, unless the period has already ended".
    historicalTo: today > to ? to : today < from ? from : today,
    // A tab change is a place the reader can go back from, so it pushes. A stepper click is not.
    //
    // The write sits in the handler, next to the navigation it accompanies, not in an effect
    // watching controls.tab. An effect would fire for a range that arrived in a link rather than
    // from this reader, and quietly adopt a stranger's choice as their preference.
    setTab: (tab) => { writeRange(tab); go({ range: tab }, false) },
    setAnchor: (anchor) => { go({ on: anchor }, true) },
    step: (direction) => { go({ on: stepAnchor(controls.tab, controls.anchor, direction) }, true) },
    setSource: (source) => { go({ source }, false) },
  }
}
