import { useEffect, useState } from 'react'
import { localToday } from './range.js'

/**
 * Milliseconds from `now` to the next 00:00 wall clock time in `timezone` (the browser's zone when
 * undefined), worked out from the wall clock Intl reports there so a zone's own offset applies.
 */
export function msUntilLocalMidnight(timezone: string | undefined, now: Date): number {
  const options: Intl.DateTimeFormatOptions = timezone === undefined ? {} : { timeZone: timezone }
  const parts = new Intl.DateTimeFormat('en-GB', {
    ...options, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now)
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const elapsed = ((part('hour') * 60 + part('minute')) * 60 + part('second')) * 1000 + now.getMilliseconds()
  return 86_400_000 - elapsed
}

const HOUR_MS = 3_600_000

/**
 * The person's today, moving on at their local midnight for a page left open. The wait is capped at
 * an hour so a DST transition (a day that is 23 or 25 hours long) is re-checked rather than
 * trusted to one long timer.
 */
export function useToday(timezone: string | undefined): string {
  const [state, setState] = useState(() => ({ timezone, day: localToday(timezone) }))
  // A changed zone is answered in the same render, so no frame shows the old zone's day.
  const today = state.timezone === timezone ? state.day : localToday(timezone)

  useEffect(() => {
    let handle: ReturnType<typeof setTimeout> | undefined
    // Rescheduled by hand: a capped wake-up that finds the same day changes no state, so an effect
    // keyed on the day would never run again and the page would stop rolling over.
    const tick = (): void => {
      const day = localToday(timezone)
      setState((prev) => (prev.timezone === timezone && prev.day === day ? prev : { timezone, day }))
      handle = setTimeout(tick, Math.min(msUntilLocalMidnight(timezone, new Date()) + 1_000, HOUR_MS))
    }
    tick()
    return () => { clearTimeout(handle) }
  }, [timezone])

  return today
}
