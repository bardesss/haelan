import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { formatClock } from '../../../format.js'
import { navigate, readQuery, useRoute, withQuery } from '../../../router.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { DetailNav, PageHeader, useHeaderDate } from '../../../components/PageHeader.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { nightPath } from '../NightRow.js'

/**
 * Opens another night's page, keeping the reader's `source` from the URL: the night page's own
 * figures are the one night the server picks for the date, but the traces below still honour a
 * named source, and moving to another night should not quietly drop a choice the reader made.
 * The header's arrows and the hero strip's dots both go through this.
 */
export function useOpenNight(): (localDate: string) => void {
  const route = useRoute()
  const source = readQuery(route.split('?')[1] ?? '').get('source')
  return useCallback((target: string) => {
    navigate(withQuery(nightPath(target), { source }))
  }, [source])
}

/**
 * The night page's header row, the dashboard's own (PageHeader): the date, when the night ran and
 * who recorded it, then ‹ › to the nights either side and a way back to every night (DetailNav).
 *
 * Bed and wake are the page's own bedtime and wake time figures, the same numbers the Bedtime row
 * below prints and the schedule later on draws, so the header cannot name a time the page itself
 * disagrees with. Where the arrows go is the payload's `nav`, never a date computed here: the
 * server knows which dates hold a night, and a gap is stepped over rather than landed on.
 *
 * Without a payload (`page` undefined: loading, a date with no night, a failed read) the row is
 * still drawn, titled with the date from the URL, the arrows disabled and the way back live, so a
 * missing night is never a dead end.
 *
 * A step keeps the reader's `source` from the URL (useOpenNight).
 */
export function NightTop({ localDate, page }: { localDate: string | undefined, page?: NightPageData }) {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const onPick = useOpenNight()
  const date = useHeaderDate(page?.localDate ?? localDate)
  const clock = (minutes: number | null) => (minutes === null ? t('common.absent') : formatClock(minutes))

  const line = page === undefined ? undefined : t('sleep.night.when', {
    bed: clock(page.figures.bedtime.value), wake: clock(page.figures.waketime.value), source: nameOf(page.sourceId),
  })
  const nav = (
    <DetailNav label={t('sleep.night.nav')} previous={page?.nav.previous ?? null} next={page?.nav.next ?? null} onPick={onPick}
      labels={{ previous: t('sleep.night.previous'), next: t('sleep.night.next') }}
      back={{ to: '/sleep', text: t('sleep.night.allNights') }} />
  )
  return <PageHeader title={date ?? t('sleep.night.nav')} line={line} nav={nav} />
}
