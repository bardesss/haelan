import { useTranslation } from '../i18n/index.js'

/**
 * The line beneath a drawn hypnogram saying a sleep session was thrown out of the night it draws.
 * The night page's About fold (NightAbout) says it under the night's sessions; the night comes
 * from packages/core/src/query/sleepNights.ts, which assembles it from the applied session set and
 * reports what it excluded alongside it, so a night an exclusion shortened is never left
 * unexplained. One component, so a second copy of this paragraph cannot drift.
 *
 * `count` rather than the excluded ids themselves: the call site already reduces to the night's
 * `excludedSessions.length`, and this component's only job is the zero/nonzero branch
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
