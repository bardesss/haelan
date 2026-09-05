import { useTranslation } from '../i18n/index.js'

/**
 * The line beneath a drawn hypnogram saying a sleep session was thrown out of the night it draws.
 * Dashboard.tsx and Sleep.tsx both build their hypnogram from the same useNights row
 * (packages/core/src/query/sleepNights.ts assembles a night from the applied session set and
 * reports what it excluded alongside it), so a night an exclusion shortened needs the same
 * explanation on both pages, not a second copy of this paragraph one page's edit could leave the
 * other still drawing an unexplained short night.
 *
 * `count` rather than the excluded ids themselves: both call sites already reduce to
 * `lastNight.excludedSessions.length`, and this component's only job is the zero/nonzero branch
 * and the plural, neither of which needs the ids.
 */
export function NightExcludedSessions({ count }: { count: number }) {
  const { t } = useTranslation()
  // excludedSessions is always present (empty is a measurement, packages/core/src/
  // query/sleepNights.ts), so a shorter night this reader threw a session out of reads as a
  // decision here rather than a recording that just happened to be short.
  if (count === 0) return null
  return <p className="chart-note">{t('sleep.sleepStages.nightExcludedSessions', { count })}</p>
}
