import { useTranslation } from '../../i18n/index.js'
import { formatSessionDateHeading, formatClock } from '../../format.js'
import { localMinutesOf, inWindow, WIDE_WINDOW } from '../../charts/schedule.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import type { Night } from '../../data/useNights.js'

/**
 * The date, the clock at both ends, and who recorded it.
 *
 * Bed and wake come from the night's own instants rather than from sleep_bedtime_minutes and
 * sleep_waketime_minutes, the same choice Sleep.tsx makes for its hypnogram label and for the same
 * reason: the hypnogram beside this header is drawn from those instants, and a label sourced from
 * anywhere else could disagree with the chart it labels.
 */
export function NightHeader({ night }: { night: Night }) {
  const { t, i18n } = useTranslation()
  const { nameOf } = useSourceNames()
  const bed = inWindow(localMinutesOf(night.localDate, night.startMs, night.startOffsetMinutes), WIDE_WINDOW)
  const wake = inWindow(localMinutesOf(night.localDate, night.endMs, night.endOffsetMinutes), WIDE_WINDOW)

  return (
    <header className="night-header">
      <h1 className="night-title">{formatSessionDateHeading(night.localDate, i18n.language)}</h1>
      <p className="night-when">
        {t('sleep.night.when', {
          bed: formatClock(bed), wake: formatClock(wake), source: nameOf(night.sourceId),
        })}
      </p>
    </header>
  )
}
