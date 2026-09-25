import { useCallback, useEffect, useMemo } from 'react'
import { useRoute, navigate, withQuery, readQuery } from '../../router.js'
import { useSession } from '../../auth/session.js'
import { isRealDate, localToday } from '../../controls/range.js'

/**
 * The dashboard's own day, read from and written to `?day=` (M9c spec, "On screen": "URL:
 * `/?day=YYYY-MM-DD`; today has no parameter... An invalid or future `day` in the URL falls back
 * to today").
 *
 * The URL is the only copy of this state, the same discipline `usePageControls` keeps for the
 * other pages' range and anchor, and for the same reason its own doc comment gives: nothing here
 * holds it in React state for an effect to mirror back, because that mirroring shape is what
 * produced M3a's session expiry loop. `day: null` always means today, never the literal string, so
 * every reader of this hook can compare against it without also knowing today's date.
 */
export function useDashboardDay(): {
  day: string | null
  setDay: (day: string | null, opts?: { replace?: boolean }) => void
} {
  const route = useRoute()
  const session = useSession()
  const today = useMemo(() => localToday(session.data?.timezone), [session.data?.timezone])

  const search = route.includes('?') ? route.slice(route.indexOf('?')) : ''
  const raw = readQuery(search).get('day')
  const valid = raw !== null && isRealDate(raw) && raw <= today
  // Today spelled out (`?day=<today>`, a bookmark from yesterday's today, say) is cleaned the same
  // way: today has no parameter, so there is only ever one URL for it.
  const unclean = raw !== null && (!valid || raw === today)
  const day = valid && raw !== today ? raw : null

  // The one effect this hook needs, and it is not a mirror: `usePageControls` avoids an effect
  // because its state is always derivable from the URL as it stands, with nothing left to correct.
  // A malformed or future `day` has no honest derived value to fall back to in the URL itself - the
  // spec asks for the URL to change, not just for this hook's return value to lie about it - so
  // fixing it up is inherently a write in reaction to what the reader (or a stale bookmark) already
  // put there, which is exactly what an effect is for.
  useEffect(() => {
    if (unclean) navigate(withQuery(route, { day: null }), { replace: true })
  }, [unclean, route])

  // Stable for as long as the route and today are, so a caller's effect can list it as a dependency.
  // Asking for the day already shown (the calendar's selected day, Today while on today) is a
  // no-op: a push there would leave a Back that goes nowhere.
  const setDay = useCallback((next: string | null, opts?: { replace?: boolean }) => {
    const target = next === null || next === today ? null : next
    if (target === day) return
    navigate(withQuery(route, { day: target }), { replace: opts?.replace ?? false })
  }, [route, today, day])

  return { day, setDay }
}
