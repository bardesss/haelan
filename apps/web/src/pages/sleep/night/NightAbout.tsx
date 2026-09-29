import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { NightExcludedSessions } from '../../../components/NightExcludedSessions.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { NightSessions } from '../NightSessions.js'
import type { Night } from '../../../data/useNights.js'

/**
 * The night page's last card, folded shut by default (M10a-2 task 7, the mockup's "Over deze
 * nacht"): the session list a night was assembled from, and the notice a correction shortened it,
 * both of which used to sit in their own place on the page (NightSessions' own card, and a line
 * under NightThrough's naps) and now sit here together, behind one disclosure triangle. A reader
 * who never excludes a session never needs either open; one who does finds both where the action
 * that would touch them lives.
 *
 * Above the fold, one line saying what is behind it, counted off the night itself: how many
 * recordings from which source, how many naps, and what can be done there (the mockup's "Eén
 * opname van Fitbit · geen dutjes · uitsluiten of een notitie toevoegen"). It replaced a long
 * basis sentence explaining how a night is assembled, which a reader met before knowing whether
 * they cared.
 *
 * `<details>`, not a state toggle: the fold needs no data of its own to open, and happy-dom does
 * not hide a closed one's children the way a real browser does (see this file's own test, which
 * asserts the `open` attribute rather than visibility for exactly that reason).
 */
export function NightAbout({ night }: { night: Night }): ReactNode {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const naps = night.naps.length
  const line = [
    t('sleep.night.about.recordings', { count: night.sessionIds.length, source: nameOf(night.sourceId) }),
    naps === 0 ? t('sleep.night.about.napsNone') : t('sleep.night.about.naps', { count: naps }),
    t('sleep.night.about.action'),
  ].join(' · ')
  return (
    <Card span={12} label={t('sleep.night.about.label')}>
      <p className="night-about-line">{line}</p>
      <details className="night-about">
        <summary>{t('sleep.night.about.details')}</summary>
        <NightSessions night={night} />
        <NightExcludedSessions count={night.excludedSessions.length} />
      </details>
    </Card>
  )
}
