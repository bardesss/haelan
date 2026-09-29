import { useCallback } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Link, readQuery, useRoute, withQuery } from '../../router.js'
import { formatDuration, formatClock, formatWeekdayDate } from '../../format.js'
import { standingShort, verdictTone } from '../../charts/base.js'
import type { SleepListRow } from '../../data/periodTypes.js'

/** One spelling of the path, shared by the row that links there and the tests that assert it. */
export function nightPath(localDate: string): string {
  return `/sleep/night/${encodeURIComponent(localDate)}`
}

/**
 * A night's page as a link from wherever the reader is, keeping the `source` their URL names: the
 * night page's traces still honour it, and moving to a night should not drop a choice the reader
 * made. Every way onward to a night goes through this (the night page's arrows and strip, the Sleep
 * page's list, point panel and Day tab).
 */
export function useNightHref(): (localDate: string) => string {
  const route = useRoute()
  const source = readQuery(route.split('?')[1] ?? '').get('source')
  return useCallback((localDate: string) => withQuery(nightPath(localDate), { source }), [source])
}

/**
 * A night's own row in the Sleep page's list, linking to its night page: the date, the time asleep,
 * a dot in the tone of the server's verdict on that night (verdictTone, plain when usual), bed to
 * wake, and ✦ for a good night (PATTERNS.md's good-day mark). Every figure is the period read's own
 * (SleepListRow), so the row prints what the hero and its strip print for the same night. The dot's
 * standing is said in words for a screen reader, since a colour alone says nothing there.
 */
export function NightRow({ night }: { night: SleepListRow }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const nightHref = useNightHref()
  const tone = verdictTone(night.judged, night.standing)
  const standing = standingShort(night.standing ?? undefined, 'minutes', t)
  const { bedtimeMinutes: bed, waketimeMinutes: wake } = night

  return (
    <Link to={nightHref(night.localDate)} className="night-row-link">
      <div className="night-row">
        <div className="night-row-main">
          <span className="night-row-primary">
            <span className="night-row-date">{formatWeekdayDate(night.localDate, language)}</span>
            <span className="night-row-duration">
              {night.asleepMinutes === null ? t('common.absent') : formatDuration(night.asleepMinutes, language)}
            </span>
            <span className={tone === null ? 'night-row-dot' : `night-row-dot ${tone}`} aria-hidden="true" />
            {standing !== '' && <span className="sr-only">{standing}</span>}
            {night.good && <span className="night-row-good">✦</span>}
          </span>
          {bed !== null && wake !== null && (
            <span className="night-row-clock">
              {t('sleep.nights.clock', { bed: formatClock(bed), wake: formatClock(wake) })}
            </span>
          )}
        </div>
      </div>
    </Link>
  )
}
