import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { localToday } from '../controls/range.js'

// Mirrors packages/core/src/query/glanceCalendar.ts (the M9c spec, "Server and data"), the same
// choice useGlance.ts makes for the glance payload and for the same reason: apps/web imports only
// @haelan/core's browser-safe subpaths, never its root export.

export type CalendarSleep = 'within' | 'outside' | null
export type CalendarSteps = 'reached' | 'below' | null

export interface GlanceCalendarDay {
  localDate: string
  sleep: CalendarSleep
  steps: CalendarSteps
}

export interface GlanceCalendar {
  month: string
  /** The earliest local date anywhere in the archive with data, never just this month's. Null when the person has none at all. */
  firstDay: string | null
  days: GlanceCalendarDay[]
}

export function glanceCalendarKey(personId: string, month: string): readonly unknown[] {
  return queryKeys.resource(personId, 'glance-calendar', { month })
}

/**
 * A calendar month for the day-navigation popover (M9c), or nothing when no month is open.
 *
 * `month: null` means the calendar is closed: `enabled` stays false so opening it later is the
 * first fetch, not a request this hook already made and threw away. A month that has already
 * finished (every earlier one) never changes again, so it is cached forever once fetched - the
 * current month is left at the query client's own default staleTime, since today can still add a
 * day to it between one open and the next.
 */
export function useGlanceCalendar(month: string | null): {
  calendar: GlanceCalendar | undefined
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
} {
  const session = useSession()
  const personId = session.data?.personId
  const finished = month !== null && month < localToday(session.data?.timezone).slice(0, 7)
  const query = useQuery({
    queryKey: glanceCalendarKey(personId ?? '', month ?? ''),
    // The same race useSeries and useSourceNames guard: asking before the session resolves would
    // cache an answer under a key naming no person. `month === null` is the calendar closed, not
    // a request for some canonical "no month".
    enabled: personId !== undefined && month !== null,
    queryFn: () => apiGet<GlanceCalendar>(`/api/v1/p/${personId!}/glance/calendar?month=${encodeURIComponent(month!)}`),
    ...(finished ? { staleTime: Infinity } : {}),
  })

  return {
    calendar: query.data,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => { void query.refetch() },
  }
}
