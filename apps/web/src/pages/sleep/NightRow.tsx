import { useTranslation } from '../../i18n/index.js'
import { Link } from '../../router.js'
import { formatDuration, formatClock, formatSessionDateHeading } from '../../format.js'
import { localMinutesOf, inWindow, WIDE_WINDOW } from '../../charts/schedule.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import type { Night } from '../../data/useNights.js'

/** One spelling of the path, shared by the row that links there and the tests that assert it. */
export function nightPath(localDate: string): string {
  return `/sleep/night/${encodeURIComponent(localDate)}`
}

/**
 * A night's own row: the date, who recorded it, how long it ran, and bed to wake.
 *
 * The span is the night's own `startMs`/`endMs`, which readSleepNights sets to bedtime and wake
 * through assembleNights - an afternoon nap on the same date sits in `naps` rather than inside the
 * span, so this duration is time in bed for the night rather than the distance between the day's
 * first and last sleep instants. Time asleep is a derived metric and deliberately not shown here:
 * the list has no /series request of its own, and a row inventing one from the segments would be
 * this surface computing a figure derive/sleep.ts already owns.
 */
export function NightRow({ night }: { night: Night }) {
  const { t, i18n } = useTranslation()
  const { nameOf } = useSourceNames()
  const language = i18n.language

  const minutes = Math.round((night.endMs - night.startMs) / 60_000)
  const bedMinutes = inWindow(
    localMinutesOf(night.localDate, night.startMs, night.startOffsetMinutes), WIDE_WINDOW)
  const wakeMinutes = inWindow(
    localMinutesOf(night.localDate, night.endMs, night.endOffsetMinutes), WIDE_WINDOW)

  return (
    <Link to={nightPath(night.localDate)} className="night-row-link">
      <div className="night-row">
        <div className="night-row-main">
          <span className="night-row-primary">
            {/* Trailing space for the same reason SessionRow's own sr-only date carries one: a
                screen reader arriving at a row by arrow key has no guarantee it heard the date
                heading above it, and without the space the two text nodes concatenate. */}
            <span className="sr-only">{`${formatSessionDateHeading(night.localDate, language)} `}</span>
            <span className="night-row-duration">{formatDuration(minutes)}</span>
            <span className="night-row-source">{nameOf(night.sourceId)}</span>
          </span>
          <span className="night-row-clock">
            {t('sleep.nights.clock', { bed: formatClock(bedMinutes), wake: formatClock(wakeMinutes) })}
          </span>
        </div>
        {night.excludedSessions.length > 0 && (
          <div className="night-row-excluded">
            {t('sleep.nights.excluded', { count: night.excludedSessions.length })}
          </div>
        )}
      </div>
    </Link>
  )
}
