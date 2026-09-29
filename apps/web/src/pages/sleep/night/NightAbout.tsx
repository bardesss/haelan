import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { NightExcludedSessions } from '../../../components/NightExcludedSessions.js'
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
 * `<details>`, not a state toggle: the fold needs no data of its own to open, and happy-dom does
 * not hide a closed one's children the way a real browser does (see this file's own test, which
 * asserts the `open` attribute rather than visibility for exactly that reason).
 */
export function NightAbout({ night }: { night: Night }): ReactNode {
  const { t } = useTranslation()
  return (
    <Card span={12} label={t('sleep.night.about.label')} basis={t('sleep.night.sessions.basis')}>
      <details className="night-about">
        <summary>{t('sleep.night.about.details')}</summary>
        <NightSessions night={night} />
        <NightExcludedSessions count={night.excludedSessions.length} />
      </details>
    </Card>
  )
}
