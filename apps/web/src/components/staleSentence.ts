import type { Translate } from '../format.js'
import { formatLocalDate } from '../format.js'

/**
 * The sentence a stale-source warning reads, joined into one string when more than one source
 * feeds the same card ("My watch has not reported since ...; it usually reports daily. Scale has
 * not reported since ..."). Moved verbatim out of MetricCard.tsx, which built this inline, so that
 * the glance page (which prints the same warning per figure rather than per range card) and the
 * metric cards say the exact same words about the exact same source rather than drifting into two
 * separately maintained copies.
 *
 * Undefined for no sources, not an empty string: MetricCard's own `warning` prop on `Card` reads
 * `undefined` as "nothing to warn about" and an empty string as a warning with nothing in it, which
 * would still open the warning UI with a blank title.
 */
export function staleSentence(
  sources: readonly { name: string, lastReportedDate: string, medianGapDays: number | null }[],
  t: Translate,
  language: string,
): string | undefined {
  if (sources.length === 0) return undefined
  return sources.map((source) => {
    const date = formatLocalDate(source.lastReportedDate, language)
    if (source.medianGapDays === null) return t('staleSource.sentenceNoCadence', { name: source.name, date })
    const gap = Math.round(source.medianGapDays)
    const usual = gap <= 1 ? t('staleSource.daily') : t('staleSource.every', { count: gap })
    return t('staleSource.sentence', { name: source.name, date, usual })
  }).join(' ')
}
