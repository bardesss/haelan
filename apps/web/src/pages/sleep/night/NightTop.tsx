import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { formatClock, formatSessionDateHeading } from '../../../format.js'
import { Link, navigate, readQuery, useRoute, withQuery } from '../../../router.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { StepArrows } from '../../../components/StepArrows.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { nightPath } from '../NightRow.js'

/**
 * The night page's header row: the date, when the night ran and who recorded it, then ‹ › to the
 * nights either side and a way back to every night.
 *
 * Bed and wake are the page's own bedtime and wake time figures, the same numbers the Bedtime row
 * below prints and the schedule later on draws, so the header cannot name a time the page itself
 * disagrees with. Where the arrows go is the payload's `nav`, never a date computed here: the
 * server knows which dates hold a night, and a gap is stepped over rather than landed on.
 *
 * A step keeps the reader's `source` from the URL: the night page's own figures are the one night
 * the server picks for the date, but the traces below still honour a named source, and stepping
 * should not quietly drop a choice the reader made.
 */
export function NightTop({ page }: { page: NightPageData }) {
  const { t, i18n } = useTranslation()
  const { nameOf } = useSourceNames()
  const route = useRoute()
  const source = readQuery(route.split('?')[1] ?? '').get('source')
  const clock = (minutes: number | null) => (minutes === null ? t('common.absent') : formatClock(minutes))
  const onPick = useCallback((target: string) => {
    navigate(withQuery(nightPath(target), { source }))
  }, [source])

  return (
    <div className="dash-header night-top">
      <div className="dash-heading">
        <h1 className="dash-title">{formatSessionDateHeading(page.localDate, i18n.language)}</h1>
        <p className="dash-date night-when">
          {t('sleep.night.when', {
            bed: clock(page.figures.bedtime.value), wake: clock(page.figures.waketime.value), source: nameOf(page.sourceId),
          })}
        </p>
      </div>
      <div className="night-top-nav">
        <div className="day-nav" role="group" aria-label={t('sleep.night.nav')}>
          <StepArrows previous={page.nav.previous} next={page.nav.next} onPick={onPick}
            labels={{ previous: t('sleep.night.previous'), next: t('sleep.night.next') }} />
        </div>
        <Link to="/sleep" className="night-all">{t('sleep.night.allNights')}</Link>
      </div>
    </div>
  )
}
