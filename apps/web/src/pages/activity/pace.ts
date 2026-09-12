import { formatNumber } from '../../format.js'

/**
 * mm:ss per kilometre, the shape a pace reads as rather than a plain decimal (378.5 seconds
 * reads as "6:19 /km", not "6.3"). The minutes half still goes through formatNumber so it group
 * separates like every other count here if a pace is ever slow enough to reach three digits; the
 * seconds half is a clock position rather than a quantity, zero padded the same way formatClock's
 * own seconds half is in format.ts, not run through Intl a second time for the same reason that one
 * is not.
 */
export function formatPace(secondsPerKm: number, language: string): string {
  const totalSeconds = Math.round(secondsPerKm)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${formatNumber(minutes, 0, language, '0')}:${String(seconds).padStart(2, '0')}`
}
