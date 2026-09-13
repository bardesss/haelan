import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { AnnotatePanel } from '../../components/AnnotatePanel.js'
import type { Night } from '../../data/useNights.js'

/**
 * The night's own sessions, one row per id in `night.sessionIds`, each with its own exclude
 * control. A night has no id of its own - it is assembled per (localDate, sourceId) across
 * however many sessions fall in the gap-based group assembleNights picks - so there is nothing
 * here a reader could exclude "the night" by naming. What they can exclude is a session, the
 * thing the recording actually is, and the panel this opens (`scope: 'session'`, M8b) writes
 * against exactly that.
 *
 * The session id is what is shown, not a formatted time range: it is what the person's own data
 * calls the recording (a sync id from whichever source produced it), and this card's job is to
 * let a reader name the right one to exclude, not to re-derive a clock time NightStages and
 * NightTraces already show for the night as a whole.
 *
 * A session already in `night.excludedSessions` renders as excluded rather than offering the
 * control again: the write path for un-excluding a session is the overrides list on Settings,
 * which already exists, and a second exclude button here would just be a second surface for the
 * same removal - see task 7's brief for why that surface is not duplicated.
 *
 * One `openSessionId` rather than a boolean, unlike WorkoutDetail's own `annotating`: this card
 * lists several sessions, so which one a click named has to be state, not just whether the panel
 * is open at all.
 */
export function NightSessions({ night }: { night: Night }): ReactNode {
  const { t } = useTranslation()
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)

  return (
    <Card span={12} label={t('sleep.night.sessions.label')} basis={t('sleep.night.sessions.basis')}>
      <ul className="night-sessions">
        {night.sessionIds.map((sessionId) => {
          const excluded = night.excludedSessions.includes(sessionId)
          return (
            <li key={sessionId} className="night-session">
              <span className="night-session-id">{sessionId}</span>
              {excluded
                ? <span className="night-session-excluded">{t('sleep.night.sessions.excluded')}</span>
                : (
                  <button type="button" className="button" onClick={() => setOpenSessionId(sessionId)}>
                    {t('sleep.night.sessions.exclude')}
                  </button>
                )}
            </li>
          )
        })}
      </ul>
      {openSessionId !== null && (
        <AnnotatePanel
          target={{ scope: 'session', localDate: night.localDate, sessionId: openSessionId }}
          onClose={() => setOpenSessionId(null)}
        />
      )}
    </Card>
  )
}
