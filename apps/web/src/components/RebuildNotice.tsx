import { useTranslation } from '../i18n/index.js'

export interface RebuildNoticeProps {
  quarantined: boolean
  /**
   * This person's derived rows are stamped at a version this build does not derive at, so sync
   * and the derive drainer both skip them until a boot rebuilds them. Distinct from a
   * quarantine, which is also true of a quarantined person: nothing here has failed, and a
   * rebuild is the whole of the remedy. Whether that rebuild is already running is a separate
   * question, which rebuildInFlight below answers - the state is the same either way, and only
   * what the reader should do about it differs.
   */
  awaitingRebuild: boolean
  /**
   * Whether the boot rebuild worker is running right now, which both routes report once per
   * response rather than once per person: one worker rebuilds the whole household in a single
   * pass, so it is a fact about the server process and not about whoever this notice is for.
   *
   * It only ever refines `awaitingRebuild`, never speaks on its own. A rebuild being in flight
   * says nothing at all about somebody whose stamp is current, and this component would have to
   * stay silent about them or every household member would be told their data had stopped at
   * every restart.
   */
  rebuildInFlight: boolean
  droppedPages: number
  drops: { dataType: string, reason: string, pages: number }[]
  lastError: string | null
  /** 'self' addresses the person whose data it is, 'admin' describes someone else's. */
  voice: 'self' | 'admin'
  personName?: string
}

/**
 * One component for both places this state is shown: the affected person's own control row and
 * the admin's household list. Shared rather than written twice, because a member told one thing
 * on their dashboard and an operator told another in settings is worse than either message alone.
 *
 * The three states are worded differently on purpose. A quarantine means "your data has stopped
 * and somebody must act". Awaiting a rebuild means "your data has stopped and a rebuild starts it
 * again" - in two wordings, because whether that rebuild is already running changes the only
 * thing the reader could do about it, and telling somebody to restart a server that is rebuilding
 * makes their situation worse. Dropped pages mean "some history is missing and will return on its
 * own". Collapsing them into one severity would either alarm people about a gap that heals itself
 * or bury an outage inside a footnote.
 *
 * Returns null when there is nothing to say, so both call sites render it unconditionally rather
 * than each repeating the same guard.
 */
export function RebuildNotice({
  quarantined, awaitingRebuild, rebuildInFlight, droppedPages, drops, lastError, voice, personName,
}: RebuildNoticeProps) {
  const { t } = useTranslation()

  if (!quarantined && !awaitingRebuild && droppedPages === 0) return null

  return (
    <div className="maintenance">
      {/* .maintenance-blocked: the same negative-toned box Maintenance.tsx uses for the one fact
          worth a household's attention before they click reclaim -- a quarantine is exactly that
          register, since it names something already broken and waiting on a person to act. */}
      {quarantined && (
        <p className="maintenance-blocked">
          {voice === 'self'
            ? t('settings.rebuild.quarantinedSelf')
            : t('settings.rebuild.quarantinedOther', { name: personName })}
        </p>
      )}
      {/* Suppressed while quarantined, although both flags are true of a quarantined person:
          their stamp rolled back with their transaction, so peopleNeedingRebuild returns them
          too, and both routes report the raw fact rather than choosing between them. The choice
          belongs here because only here does saying both do harm. "A restart runs it" is the
          one promise that is certainly false for a quarantine - the failure is deterministic, so
          the next boot fails in exactly the same place - and printing it under a line that has
          just asked for an administrator would send the reader to reboot instead.

          .maintenance-waiting: the plain secondary register Maintenance.tsx's own statements
          carry, not the negative box above. Their data has genuinely stopped, which is why it is
          not the muted note either, but nothing is broken and nobody has to diagnose anything. */}
      {awaitingRebuild && !quarantined && (
        <p className="maintenance-waiting">
          {/* Two wordings of one state, chosen on whether the rebuild that fixes it is running.
              A refinement of this line rather than a fourth line of its own, which is why it
              inherits the quarantine suppression above instead of restating it: a quarantined
              person reads true on every flag at once, and "a rebuild is running now" is
              reassurance about a failure that is deterministic and will recur in the same place.

              The distinction is not a nicety. apps/server/src/index.ts calls app.listen BEFORE
              the boot rebuild starts, and that rebuild runs in its own process for as long as
              fifteen minutes on real data while holding the write lock. For the whole of that
              run every person the worker has not reached yet has a stale stamp, so this line
              renders for them during the run that is fixing them - and right after an upgrade is
              the single most likely moment anybody reads it at all. Told that a restart is the
              remedy, an operator restarts the container and aborts a rebuild that would have
              finished, which leaves them exactly where they started and costs another fifteen
              minutes on the next try.

              Saying nothing while a rebuild runs was the alternative and was rejected: a person
              whose data has stopped should not be shown a blank space where the explanation was.
              So the state is reported either way and only the sentence about what happens next
              changes - and in the running case it asks for nothing, because nothing is wanted. */}
          {rebuildInFlight
            ? (voice === 'self'
                ? t('settings.rebuild.awaitingRunningSelf')
                : t('settings.rebuild.awaitingRunningOther', { name: personName }))
            : (voice === 'self'
                ? t('settings.rebuild.awaitingSelf')
                : t('settings.rebuild.awaitingOther', { name: personName }))}
        </p>
      )}
      {/* .maintenance-download-note: the same muted register Maintenance.tsx uses for a fact that
          is true but not alarming -- dropped pages heal themselves once the cause is fixed, the
          same way that note's own credentials caveat is a condition rather than a failure. */}
      {droppedPages > 0 && (
        <p className="maintenance-download-note">
          {voice === 'self'
            ? t('settings.rebuild.droppedSelf')
            : t('settings.rebuild.droppedOther', { count: droppedPages, name: personName })}
        </p>
      )}
      {drops.length > 0 && (
        <>
          <p className="maintenance-retention">{t('settings.rebuild.dropsHeading')}</p>
          {/* Keyed on the pair, not on the data type. rebuild_drops' own primary key is
              (person_id, data_type, reason), so one data type failing two ways is two rows -
              which is exactly what the per-page isolation unit produces, since it groups drops
              by the normalised reason. The data type alone is therefore not unique here, and
              a duplicate key lets the reconciler carry the wrong child across a re-render.

              Serialised rather than joined on a separator, because the reason is a SQLite error
              message and already carries every punctuation mark worth reaching for ("UNIQUE
              constraint failed: session_segments.id"). A separator the parts can contain lets
              two different pairs spell one key, which is the bug this line exists to fix. */}
          {drops.map((drop) => (
            <p className="maintenance-download-note" key={JSON.stringify([drop.dataType, drop.reason])}>
              {t('settings.rebuild.dropRow', { dataType: drop.dataType, count: drop.pages, reason: drop.reason })}
            </p>
          ))}
        </>
      )}
      {/* Shown verbatim whenever the store recorded one, rather than folded under one of the
          states above, which would hide it in the others. What can and cannot reach this string
          is answered in one place, the catch in packages/core/src/rebuild/runRebuild.ts that
          captures it; neither route that forwards the column repeats the argument and neither
          does this.

          In practice it now appears only beside a quarantine, because recordSuccess clears the
          error columns when a later rebuild commits. That is why the condition here is still the
          column rather than the quarantine flag: this renders whatever the store is holding, and
          it is the store that decides when an error stops being the last thing that happened. */}
      {lastError !== null && (
        <>
          <p className="maintenance-retention">{t('settings.rebuild.errorHeading')}</p>
          <p className="maintenance-download-note">{lastError}</p>
        </>
      )}
    </div>
  )
}
