import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { AnnotatePanel } from '../../components/AnnotatePanel.js'
import type { Night } from '../../data/useNights.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import { formatRecordedClock } from '../../format.js'

/**
 * Every one of this date's sleep sessions this source produced - both the ones the night below
 * was assembled from (`night.sessionIds`) and the ones a person excluded from it
 * (`night.excludedSessions`) - one row each, the kept ones with their own exclude control and the
 * excluded ones already marked so. A night has no id of its own - it is assembled per
 * (localDate, sourceId) across however many sessions fall in the gap-based group assembleNights
 * picks - so there is nothing here a reader could exclude "the night" by naming. What they can
 * exclude is a session, the thing the recording actually is, and the panel this opens
 * (`scope: 'session'`, M8b) writes against exactly that.
 *
 * Each row is named the way the workout page names a workout: the source that recorded it and its
 * own clock times ("Pixel Watch · 00:08–07:09"), read in the wall clock it was recorded in
 * (formatRecordedClock). The sync id it used to show is what the data calls the recording, but no
 * reader recognises one, and two recordings of one night are told apart by when they ran. The
 * button's words are the workout page's (`common.annotate`), one wording for one action.
 *
 * `night.sessionIds` and `night.excludedSessions` are disjoint by construction - readSleepNights
 * (packages/core/src/query/sleepNights.ts) assembles the kept night from one set of rows and
 * separately collects the ones a correction dropped into the other - so concatenating them needs
 * no dedup, and a session id can only ever land in one of the two rendered shapes below, never
 * both. A session in `night.excludedSessions` renders as excluded rather than offering the
 * control again: the write path for un-excluding a session is the overrides list on Settings,
 * which already exists, and a second exclude button here would just be a second surface for the
 * same removal - see task 7's brief for why that surface is not duplicated.
 *
 * One `openSessionId` rather than a boolean, unlike WorkoutDetail's own `annotating`: this card
 * lists several sessions, so which one a click named has to be state, not just whether the panel
 * is open at all.
 *
 * Renders no card of its own (M10a-2 task 7): NightDetail.tsx's "About this night" fold
 * (NightAbout.tsx) supplies the one Card the sessions list and the excluded-sessions notice both
 * sit inside now, this component's own frame having moved there with it.
 */
export function NightSessions({ night }: { night: Night }): ReactNode {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const source = nameOf(night.sourceId)
  const spans = new Map((night.sessionSpans ?? []).map((span) => [span.id, span]))
  // A session with no span (a response from before the field existed) still gets its source.
  const labelOf = (sessionId: string): string => {
    const span = spans.get(sessionId)
    return span === undefined ? source : t('sleep.night.sessions.recording', {
      source,
      start: formatRecordedClock(span.startMs, span.startOffsetMinutes),
      end: formatRecordedClock(span.endMs, span.endOffsetMinutes),
    })
  }

  return (
    <>
      <ul className="night-sessions">
        {[...night.sessionIds, ...night.excludedSessions].map((sessionId) => {
          const excluded = night.excludedSessions.includes(sessionId)
          return (
            <li key={sessionId} className="night-session">
              <span className="night-session-label">{labelOf(sessionId)}</span>
              {excluded
                ? <span className="night-session-excluded">{t('sleep.night.sessions.excluded')}</span>
                : (
                  <button type="button" className="button" onClick={() => setOpenSessionId(sessionId)}>
                    {t('common.annotate')}
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
    </>
  )
}
