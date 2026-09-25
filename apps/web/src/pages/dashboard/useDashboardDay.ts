import { useEffect, useMemo } from 'react'
import { useRoute, navigate, withQuery, readQuery } from '../../router.js'
import { useSession } from '../../auth/session.js'
import { localToday } from '../../controls/range.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * A real calendar date, the same check `controls/range.ts`'s own (unexported) `isRealDate` makes:
 * the regex alone would accept '2026-02-30'. Not imported from there because that module has
 * nothing to do with the day-navigation URL, and its own check is private to it.
 */
function isRealDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  if (month < 1 || month > 12) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day >= 1 && day <= daysInMonth
}

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
  const invalid = raw !== null && !valid

  // The one effect this hook needs, and it is not a mirror: `usePageControls` avoids an effect
  // because its state is always derivable from the URL as it stands, with nothing left to correct.
  // A malformed or future `day` has no honest derived value to fall back to in the URL itself - the
  // spec asks for the URL to change, not just for this hook's return value to lie about it - so
  // fixing it up is inherently a write in reaction to what the reader (or a stale bookmark) already
  // put there, which is exactly what an effect is for.
  useEffect(() => {
    if (invalid) navigate(withQuery(route, { day: null }), { replace: true })
  }, [invalid, route])

  return {
    day: valid && raw !== today ? raw : null,
    setDay: (day, opts) => {
      navigate(withQuery(route, { day: day === null || day === today ? null : day }), { replace: opts?.replace ?? false })
    },
  }
}
