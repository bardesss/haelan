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
  const [today, setToday] = useState(() => localToday(timezone))

  useEffect(() => {
    // A changed zone changes what today is right now; the timer below then follows the new value.
    const current = localToday(timezone)
    if (current !== today) {
      setToday(current)
      return undefined
    }
    const timer = setTimeout(() => {
      setToday(localToday(timezone))
    }, Math.min(msUntilLocalMidnight(timezone, new Date()) + 1_000, HOUR_MS))
    return () => { clearTimeout(timer) }
  }, [timezone, today])

  return today
}
