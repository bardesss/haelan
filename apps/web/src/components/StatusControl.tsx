import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { StatusPanel } from './StatusPanel.js'
import type { SyncOutcome } from './StatusPanel.js'
import { ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'
import { useRoute, scrollToHashTarget } from '../router.js'
import { localToday } from '../controls/range.js'
import { useIsPhone } from '../ui/breakpoint.js'
import { useStatusPanel, useRunSync, useRefreshOnSyncFinish } from '../data/useStatusPanel.js'

/**
 * The status icon beside the reader's name, and the panel it opens.
 *
 * It replaced SyncControl, which put a sync button and two freshness sentences in the rail's foot.
 * Those answered "when did Google last sync" and "when did the phone last send", which is two
 * fragments of the question a reader actually has - is my data still arriving, and if not, from
 * where did it stop - and no answer at all for a watch that quietly stopped reporting while both
 * connections stayed healthy. The panel answers per device, and the icon carries the one-word
 * summary: fine, syncing, or how many things are wrong.
 *
 * Rendered once, in the shell (Shell.tsx builds the element and hands it to the rail's foot or the
 * drawer's top bar), for the reason SyncControl gave: both rail components are mounted by tests
 * with no QueryClientProvider, and this reads queries. It is mounted for the whole session whether
 * or not the panel is open, because it is also the thing that turns a finished run into fresh
 * charts (useRefreshOnSyncFinish), and a closed panel must not switch that off.
 *
 * A popover on a desktop, opening upward out of the rail's foot the way the person menu beside it
 * does; a bottom sheet on a phone, a <dialog> written the way PeriodSheet's is, because a popover
 * anchored in a 44px top bar has nowhere to open on a 375px screen.
 */
export function StatusControl() {
  const { t } = useTranslation()
  const session = useSession()
  const status = useStatusPanel()
  const runSync = useRunSync()
  const isPhone = useIsPhone()
  const route = useRoute()
  useRefreshOnSyncFinish(status.data)

  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)

  const sync = status.data?.sync ?? null
  const running = sync?.running === true
  const problems = status.data?.problems ?? 0

  // Whether this component has watched a run, so the result line describes a sync the reader saw
  // happen rather than whichever one last finished - which could be the scheduler's, an hour ago.
  // Set by observing the status running (a run from anywhere, seen while this tab was open) or by
  // a press that succeeded (which covers the run so short it was over before the status re-read
  // could see it going). Cleared by the next press, so a refused one does not inherit the last
  // run's result.
  const [watched, setWatched] = useState(false)
  useEffect(() => { if (running) setWatched(true) }, [running])

  const outcome: SyncOutcome | null = runSync.error instanceof ApiError
    // 429 is the server's minute of cooldown after a run, which means a run just finished: the
    // true answer is "Synced just now", not a failure. 409 is a run already going, or the
    // instance shutting down; either way nothing new was started by this press.
    ? runSync.error.status === 429 ? 'cooldown' : runSync.error.status === 409 ? 'alreadyRunning' : 'didNotStart'
    : runSync.isError ? 'didNotStart'
      : watched && sync !== null && !sync.running && sync.lastFinishedAtMs !== null
        ? (sync.lastFailed ?? 0) > 0 ? 'failed' : sync.lastRowsWritten === 0 ? 'nothingNew' : 'newData'
        : null

  function startSync() {
    setWatched(false)
    runSync.mutate(undefined, { onSuccess: () => setWatched(true) })
  }

  // The person's today, not the browser's, for "today" and "yesterday" on the device rows.
  // open is a dependency on purpose: a tab left open overnight re-reads the date when the panel
  // is opened, rather than calling yesterday "today" until a reload.
  const timezone = session.data?.timezone
  const today = useMemo(() => localToday(timezone), [timezone, open])

  // Navigating closes it, for the reason the person menu gives: the rail is not unmounted by a
  // route change, and the footer's link navigates, so without this the panel would hang open over
  // the account page its own link just opened.
  useEffect(() => { setOpen(false) }, [route])

  // Escape and a press outside, registered only while the popover is open. The wrapper (icon and
  // popover together) is the inside test, so a pointerdown on the Sync button does not tear the
  // popover down before its click lands - the defect rail-menu.test.tsx's press() guards against
  // for the person menu. Escape is claimed (preventDefault, stopPropagation) so that inside the
  // phone drawer it closes this layer and not the <dialog> beneath it as well. The phone sheet is
  // a <dialog> of its own and gets Escape from the browser, so none of this runs there.
  useEffect(() => {
    if (!open || isPhone) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && wrapper.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, isPhone])

  // Focus moves into the popover on open, so a keyboard reader lands on the panel they asked for
  // rather than having to tab past the rest of the rail to reach it. The first enabled control, or
  // the popover itself when there is none (a disabled Sync button and no link cannot happen - the
  // footer link is always there - but a panel with nothing focusable should not strand focus).
  useEffect(() => {
    if (!open || isPhone) return
    const element = popover.current
    if (!element) return
    const first = element.querySelector<HTMLElement>('a[href], button:not(:disabled)')
    ;(first ?? element).focus({ preventScroll: true })
  }, [open, isPhone])

  // The phone sheet: showModal and close are imperative, so state is the source of truth and this
  // makes the element agree, guarded both ways because showModal on an open dialog throws.
  useEffect(() => {
    const element = sheet.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open, isPhone])

  // Escape closes a <dialog> without telling React; its own close event is what keeps the state
  // level with the DOM, and it covers every other way the sheet can close.
  useEffect(() => {
    const element = sheet.current
    if (!element) return
    const onClose = () => setOpen(false)
    element.addEventListener('close', onClose)
    return () => element.removeEventListener('close', onClose)
  }, [isPhone])

  // Focus back to the icon when the sheet closes, which the browser does not do for a dialog closed
  // by Escape. Skips the first run for the reason RailDrawer's identical effect gives: `open`
  // starts false, and without the guard every mount would steal focus onto this icon.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current && !open && isPhone) trigger.current?.focus({ preventScroll: true })
    mounted.current = true
  }, [open, isPhone])

  const state = running
    ? t('status.state.syncing')
    : problems > 0 ? t('status.state.problems', { count: problems }) : t('status.state.ok')

  const content = status.data !== undefined && (
    <StatusPanel status={status.data} today={today} syncPending={runSync.isPending}
      outcome={outcome} onSync={startSync} />
  )

  // A press on a link inside the panel ("Choose sources…"), caught as it bubbles past - router.tsx's
  // Link forwards no onClick of its own. Link has already navigated by the time this runs. Closing
  // here rather than leaving it to the route effect above, because a reader already on /account
  // changes no route at all (useRoute leaves the fragment out), and the panel would stay open over
  // the card its link was meant to show. For the same reason the scroll is asked for here: nothing
  // mounts, so the account page's own mount-time scroll never runs. A frame later, so the popover
  // has gone and the phone sheet's scroll lock has let go of the page before it moves.
  function onPanelClick(event: React.MouseEvent) {
    if (!(event.target instanceof Element) || event.target.closest('a[href]') === null) return
    setOpen(false)
    requestAnimationFrame(() => scrollToHashTarget())
  }

  return (
    <div className="status-control" ref={wrapper}>
      {/* aria-haspopup="dialog" on a phone, where what opens is a modal sheet; "true" on a desktop,
          where it is a popover beside the icon and aria-expanded is the honest description. The
          label carries the state, so a screen reader hears "Status: 2 problems" without opening
          anything - which is also all the dot says to a sighted reader. */}
      <button ref={trigger} type="button" className="icon-button status-button"
        aria-haspopup={isPhone ? 'dialog' : 'true'} aria-expanded={open}
        aria-label={status.data === undefined ? t('status.title') : t('status.label', { state })}
        data-running={running ? 'true' : undefined}
        onClick={() => setOpen((current) => !current)}>
        <Icon name="status" />
        {problems > 0 && <span className="status-dot" aria-hidden="true" />}
      </button>
      {!isPhone && open && (
        <div ref={popover} className="status-popover" role="dialog" aria-label={t('status.title')} tabIndex={-1}
          onClick={onPanelClick}>
          {content}
        </div>
      )}
      {isPhone && (
        // The backdrop tap is a click whose target is the dialog itself, for the reason
        // RailDrawer's comment gives; the close button is the way out a finger can find.
        <dialog ref={sheet} className="status-sheet" aria-label={t('status.title')}
          onClick={(event) => { if (event.target === sheet.current) setOpen(false) }}>
          <div className="status-sheet-body" onClick={onPanelClick}>
            <div className="status-sheet-head">
              <span className="status-sheet-title">{t('status.title')}</span>
              <button type="button" className="icon-button" data-testid="status-sheet-close"
                aria-label={t('controlRow.close')} onClick={() => setOpen(false)}>
                <Icon name="close" />
              </button>
            </div>
            {open && content}
          </div>
        </dialog>
      )}
    </div>
  )
}
