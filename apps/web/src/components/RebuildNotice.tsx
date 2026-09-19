import { useTranslation } from '../i18n/index.js'
import { formatSince } from '../format.js'

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
  /**
   * Their last rebuild was handed archived payloads and left no readings behind at all.
   *
   * Arrives already decided, unlike droppedPages beside it: the two columns behind it mean
   * nothing apart, since writing no rows is the ordinary outcome for a member connected an hour
   * ago. Both routes call the same predicate in packages/core, which is where the argument is.
   *
   * The mildest of the four states and deliberately worded that way. Nothing failed, nothing was
   * deleted, tier 1 still holds every payload, and the remedy is a version of this software that
   * can read them - which is not something the person reading their own dashboard can do, and
   * not something an administrator can do today either. So the line reports and asks for
   * nothing.
   */
  producedNothing: boolean
  drops: { dataType: string, reason: string, pages: number }[]
  lastError: string | null
  /**
   * When the last rebuild attempt failed, which dates the quarantine paragraph below. Not the
   * same timestamp that dates droppedPages and producedNothing beneath it, and deliberately so:
   * recordFailure (packages/core/src/store/rebuildState.ts) never touches lastSuccessAtMs, only
   * lastAttemptAtMs, lastErrorAtMs, lastError and consecutiveFailures - so lastSuccessAtMs stays
   * null for anyone who has never once had a rebuild commit, quarantined or not.
   *
   * Null falls back to the undated wording rather than to "just now" - a store that never
   * recorded a failure time is not the same claim as a failure recorded a moment ago, and nothing
   * upstream promises this is only null in step with quarantined being false. Reachable at this
   * component's own boundary regardless of what today's two callers happen to keep in sync.
   */
  lastErrorAtMs: number | null
  /**
   * When the last rebuild attempt COMMITTED, which dates droppedPages and producedNothing below.
   *
   * Not when either gap ITSELF began. A data type that keeps failing to map across two
   * MAPPING_VERSION bumps has this timestamp move forward on every later rebuild - each one still
   * drops the same pages or still writes nothing - while the gap those pages describe is however
   * old the FIRST bad rebuild was. So the copy below reads "as of the rebuild ... ago", which is a
   * true claim about when the figures were last measured, never "missing for ... ago", which
   * would claim an onset this timestamp does not know.
   *
   * Null falls back to the undated wording for the same reason lastErrorAtMs above does: nothing
   * ties this prop to droppedPages or producedNothing being true at the type level, even though
   * today's two callers only ever set either flag from the same row recordSuccess just stamped.
   */
  lastSuccessAtMs: number | null
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
 * own". A rebuild that produced nothing means "all of it is missing and none of it is lost",
 * which is the same reassurance at a different scale and reads as a fifth wording rather than a
 * fourth severity. Collapsing them into one severity would either alarm people about a gap that
 * heals itself or bury an outage inside a footnote.
 *
 * Returns null when there is nothing to say, so both call sites render it unconditionally rather
 * than each repeating the same guard.
 */
export function RebuildNotice({
  quarantined, awaitingRebuild, rebuildInFlight, droppedPages, producedNothing, drops, lastError,
  lastErrorAtMs, lastSuccessAtMs, voice, personName,
}: RebuildNoticeProps) {
  const { t, i18n } = useTranslation()

  if (!quarantined && !awaitingRebuild && droppedPages === 0 && !producedNothing) return null

  // Read at render rather than captured once, the same reason Members.tsx's own activity line
  // takes Date.now() at render instead of a stored clock: every "... ago" below is read off a
  // dashboard a person may leave open, and a timestamp captured on mount would quietly go stale
  // while the tab stayed open.
  const nowMs = Date.now()

  return (
    <div className="maintenance">
      {/* .maintenance-blocked: the same negative-toned box Maintenance.tsx uses for the one fact
          worth a household's attention before they click reclaim -- a quarantine is exactly that
          register, since it names something already broken and waiting on a person to act. */}
      {quarantined && (
        <p className="maintenance-blocked">
          {/* Dated from lastErrorAtMs when the store has one, which recordFailure always sets
              alongside quarantined turning true - see this component's own doc comment on the
              prop for the one case (a caller out of step with today's two) where it would not,
              and why null still has to render the plain sentence rather than crash on it. */}
          {lastErrorAtMs === null
            ? (voice === 'self'
                ? t('settings.rebuild.quarantinedSelf')
                : t('settings.rebuild.quarantinedOther', { name: personName }))
            : (voice === 'self'
                ? t('settings.rebuild.quarantinedSelfSince', { when: formatSince(lastErrorAtMs, nowMs, i18n.language) })
                : t('settings.rebuild.quarantinedOtherSince', {
                    name: personName, when: formatSince(lastErrorAtMs, nowMs, i18n.language),
                  }))}
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
          {/* Deliberately undated, unlike the three states around it. Nothing records the moment
              a version stamp went stale - PeopleStore.setTimezone nulls builtDerivationVersion in
              the same statement as the zone, and that null is the whole of what this state is,
              with no companion column recording when it happened the way lastErrorAtMs and
              lastSuccessAtMs do for the other three. It also cannot go stale the way they can: the
              next boot rebuild clears it outright rather than leaving a number sitting there
              across restarts, so there is no multi-month gap for a reader to be misled about in
              the first place. */}
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
      {/* Suppressed while quarantined AND while awaiting a rebuild, which is two suppressions
          and two different reasons.

          Quarantine, for the reason the awaiting line has it: the two columns behind this flag
          hold whatever the last attempt that COMMITTED left there, and a quarantined person's
          last commit can perfectly well have been an empty one, so the flag survives their
          failure. "Your history was rebuilt without any error" is then flatly untrue of the
          rebuild that is actually the matter with them, printed directly under a line that has
          just told them their data has stopped.

          Awaiting, because this flag is about a rebuild that has already happened and that state
          says another one is due - at the next restart, or running right now. The empty result
          describes a replay this build has superseded or is in the middle of superseding, so
          reporting it beside "a rebuild is running now" tells the reader about an outcome that
          may not survive the next few minutes. The awaiting line is also the one that says what
          happens next, which is the more useful of the two sentences; this one would only add a
          verdict that is about to be recomputed. It comes back on its own if the new rebuild is
          empty too, since recordSuccess overwrites both columns.

          Said beside a drop rather than instead of it, which is why droppedPages is NOT a third
          suppression: "some pages would not go in" and "what did go in produced nothing" are two
          facts about one rebuild that already happened, and a reader shown only the first would
          take the rest of the archive to have replayed fine.

          .maintenance-waiting rather than the muted note the drop count gets. Their pages are
          empty, which is a larger thing than a gap in them, but nothing has failed and nobody is
          being asked to do anything - the same register the awaiting line uses, and for the same
          reason it is neither the blocked box nor the footnote. */}
      {producedNothing && !quarantined && !awaitingRebuild && (
        <p className="maintenance-waiting">
          {/* Dated from lastSuccessAtMs, which is when this outcome was last MEASURED, not when
              it started - see the prop's own doc comment for the archive-that-never-remaps case
              this distinction exists for. Null falls back to the plain sentence rather than
              rendering an invalid date. */}
          {lastSuccessAtMs === null
            ? (voice === 'self'
                ? t('settings.rebuild.emptySelf')
                : t('settings.rebuild.emptyOther', { name: personName }))
            : (voice === 'self'
                ? t('settings.rebuild.emptySelfSince', { when: formatSince(lastSuccessAtMs, nowMs, i18n.language) })
                : t('settings.rebuild.emptyOtherSince', {
                    name: personName, when: formatSince(lastSuccessAtMs, nowMs, i18n.language),
                  }))}
        </p>
      )}
      {/* .maintenance-download-note: the same muted register Maintenance.tsx uses for a fact that
          is true but not alarming -- dropped pages heal themselves once the cause is fixed, the
          same way that note's own credentials caveat is a condition rather than a failure. */}
      {droppedPages > 0 && (
        <p className="maintenance-download-note">
          {/* Dated from lastSuccessAtMs, same as producedNothing above and for the same reason:
              this is when the drop was last measured, not when it started, which matters because
              a data type stuck failing across a MAPPING_VERSION bump keeps this timestamp moving
              forward on every later rebuild while the drop it describes is however old the first
              bad rebuild was. Null falls back to the plain sentence. */}
          {lastSuccessAtMs === null
            ? (voice === 'self'
                ? t('settings.rebuild.droppedSelf')
                : t('settings.rebuild.droppedOther', { count: droppedPages, name: personName }))
            : (voice === 'self'
                ? t('settings.rebuild.droppedSelfSince', { when: formatSince(lastSuccessAtMs, nowMs, i18n.language) })
                : t('settings.rebuild.droppedOtherSince', {
                    count: droppedPages, name: personName, when: formatSince(lastSuccessAtMs, nowMs, i18n.language),
                  }))}
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
