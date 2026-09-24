import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
 *
 * The popover is portalled to document.body and placed with position: fixed, not absolutely
 * positioned inside the rail like the person menu. The rail is a scroll container (overflow-y:
 * auto, which makes overflow-x compute to auto too), and a 20rem popover inside it was clipped at
 * the rail's 186px edge: about 40px of it showed, the rail grew a sideways scrollbar, and on a
 * collapsed rail nothing showed at all. The person menu gets away with it only because it is no
 * wider than the foot it opens from.
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

  // A panel opened after sitting idle should show the current state, not whatever the five-minute
  // background poll last landed on - which can be stale by up to that whole interval.
  useEffect(() => { if (open) void status.refetch() }, [open])

  const [placement, setPlacement] = useState<Placement | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)

  const sync = status.data?.sync ?? null
  const running = sync?.running === true
  const problems = status.data?.problems ?? 0

  // Whether the reader has watched a run, so the result line describes a sync they saw happen
  // rather than whichever one last finished - which could be the scheduler's, an hour ago. Set by
  // the status running while the panel is open (a run from anywhere, including one already going
  // when the panel opened) or by a press that succeeded (which covers the run so short it was over
  // before the status re-read could see it going). Cleared by the next press, so a refused one does
  // not inherit the last run's result, and by closing the panel, below.
  const [watched, setWatched] = useState(false)
  useEffect(() => { if (running && open) setWatched(true) }, [running, open])

  const outcome: SyncOutcome | null = runSync.error instanceof ApiError
    // 429 is the server's minute of cooldown after a run, which means a run just finished: the
    // true answer is "Synced just now", not a failure - and the button already says exactly that,
    // disabled, once useRunSync's onError has re-read the status the 429 proved stale. A result
    // line saying it as well put the same words in the panel twice, one under the other, so a
    // 429 has no line at all and the button carries the cooldown alone. 409 is a run already
    // going, or the instance shutting down; either way nothing new was started by this press.
    ? runSync.error.status === 429 ? null : runSync.error.status === 409 ? 'alreadyRunning' : 'didNotStart'
    : runSync.isError ? 'didNotStart'
      : watched && sync !== null && !sync.running && sync.lastFinishedAtMs !== null
        ? (sync.lastFailed ?? 0) > 0 ? 'failed' : sync.lastRowsWritten === 0 ? 'nothingNew' : 'newData'
        : null

  function startSync() {
    setWatched(false)
    runSync.mutate(undefined, { onSuccess: () => setWatched(true) })
  }

  // An outcome belongs to the moment it was reported. Closing the panel forgets it - the mutation's
  // error and the watched flag both - so "A sync is already running." or "Nothing new." does not
  // greet a reader who opens the panel again an hour later. reset is stable across renders.
  const resetRun = runSync.reset
  useEffect(() => {
    if (open) return
    resetRun()
    setWatched(false)
  }, [open, resetRun])

  // The person's today, not the browser's, for "today" and "yesterday" on the device rows.
  // open is a dependency on purpose: a tab left open overnight re-reads the date when the panel
  // is opened, rather than calling yesterday "today" until a reload.
  const timezone = session.data?.timezone
  const today = useMemo(() => localToday(timezone), [timezone, open])

  // Navigating closes it, for the reason the person menu gives: the rail is not unmounted by a
  // route change, and the footer's link navigates, so without this the panel would hang open over
  // the account page its own link just opened.
  useEffect(() => { setOpen(false) }, [route])

  // Escape and a press outside, registered only while the popover is open. The icon's wrapper and
  // the portalled popover are both the inside test, so a pointerdown on the Sync button does not tear the
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
      // Both the wrapper (the icon) and the popover count as inside: portalled to the body, the
      // popover is no longer a descendant of the wrapper.
      if (target instanceof Node && (wrapper.current?.contains(target) === true || popover.current?.contains(target) === true)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, isPhone])

  // Where the popover goes, from the icon's own rectangle. Measured in a layout effect so the first
  // painted frame is already in place, and again once the popover exists so its real size can keep
  // it inside the viewport; again on every resize, since a fixed box does not follow the rail. The
  // placement is dropped on close, so the next open never paints at a stale position first.
  useLayoutEffect(() => {
    if (!open || isPhone) { setPlacement(null); return }
    const place = () => {
      const button = trigger.current
      if (!button) return
      const box = popover.current?.getBoundingClientRect()
      const foot = button.closest('.rail-foot')?.getBoundingClientRect()
      const rail = button.closest('.rail')?.getBoundingClientRect()
      const iconRect = button.getBoundingClientRect()
      setPlacement(placementFor({
        trigger: iconRect,
        anchorLeft: foot?.left ?? iconRect.left,
        stripRight: rail?.right ?? iconRect.right,
        collapsed: button.closest('.rail-collapsed') !== null,
        size: { width: box?.width ?? 0, height: box?.height ?? 0 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, isPhone])

  // Focus moves into the popover on open, so a keyboard reader lands on the panel they asked for
  // rather than having to tab past the rest of the rail to reach it. The first enabled control, or
  // the popover itself when there is none (a disabled Sync button and no link cannot happen - the
  // footer link is always there - but a panel with nothing focusable should not strand focus).
  //
  // Only once placed: before that the popover is visibility: hidden, and a browser will not focus
  // anything inside a hidden box. Keyed on whether it is placed rather than on where, so a resize
  // that moves it does not pull focus back to the first control.
  const placed = placement !== null
  useEffect(() => {
    if (!open || isPhone || !placed) return
    const element = popover.current
    if (!element) return
    const first = element.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? element).focus({ preventScroll: true })
  }, [open, isPhone, placed])

  // Keyboard order as if the popover followed the icon, which the portal broke: in the document it
  // is the body's last child, so Tab past its last control left the rail for whatever the body
  // held after it, and Shift+Tab from its first control went to the page's last control instead of
  // back to the icon. Three edges are patched, and every Tab between the popover's own controls is
  // left to the browser.
  //
  // Shift+Tab from the first control (or from the popover itself, which is where focus sits when
  // there is nothing to focus) goes to the icon, and the popover stays open - stepping back to the
  // thing that opened a disclosure does not dismiss it. Tab from the icon while open goes into the
  // popover's first control, the forward half of the same illusion.
  //
  // Tab past the last control closes the popover and puts focus on the icon WITHOUT claiming the
  // key. The browser's default Tab runs after the keydown handlers, from wherever focus is by then,
  // so it steps from the icon to the next thing in the rail - exactly where the popover's end would
  // lead if it really sat after the icon. That is the full answer to "the element after the icon"
  // without this component having to compute tab order itself (tabindex, disabled, inert, hidden
  // and display: none all bear on it, and the browser already knows). The fallback the plan
  // allowed, closing and stopping on the icon, would cost the reader an extra Tab every time.
  function onPopoverKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Tab') return
    const element = popover.current
    if (!element) return
    const controls = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const active = document.activeElement
    if (event.shiftKey) {
      if (active === element || active === controls[0]) {
        event.preventDefault()
        trigger.current?.focus({ preventScroll: true })
      }
      return
    }
    // From the popover itself, a Tab forward is its end only when it holds no controls; otherwise
    // the default already steps into its first one, which follows it in the document.
    if (controls.length === 0 ? active === element : active === controls.at(-1)) {
      trigger.current?.focus({ preventScroll: true })
      setOpen(false)
    }
  }

  function onTriggerKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Tab' || event.shiftKey || !open || isPhone) return
    const first = popover.current?.querySelector<HTMLElement>(FOCUSABLE)
    if (!first) return
    event.preventDefault()
    first.focus({ preventScroll: true })
  }

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
  // by Escape. Keyed on open having been true on the previous run, not merely on it being false
  // now: the effect also runs when isPhone flips, and a window narrowed into phone width with the
  // panel shut used to read as "the sheet just closed" and pull focus off whatever the reader was
  // in (a mounted-once flag, which is what RailDrawer's identical effect uses, only rules out the
  // first run, and RailDrawer has no second dependency to flip). The ref starts false, which also
  // covers the mount RailDrawer's guard was for.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open && isPhone) trigger.current?.focus({ preventScroll: true })
    wasOpen.current = open
  }, [open, isPhone])

  // "All sources up to date" about a household with nothing connected is a claim about nothing, so
  // that case gets its own neutral word.
  const state = running
    ? t('status.state.syncing')
    : problems > 0 ? t('status.state.problems', { count: problems })
      : status.data?.connections.length === 0 ? t('status.state.none') : t('status.state.ok')

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
        onClick={() => setOpen((current) => !current)} onKeyDown={onTriggerKeyDown}>
        <Icon name="status" />
        {problems > 0 && <span className="status-dot" aria-hidden="true" />}
      </button>
      {!isPhone && open && createPortal(
        // Hidden until placed, so the one frame before the layout effect measures never shows it
        // at the viewport's corner. Layout effects run before paint, so in practice it never shows.
        <div ref={popover} className="status-popover" role="dialog" aria-label={t('status.title')} tabIndex={-1}
          style={placement === null ? { visibility: 'hidden' } : { left: `${placement.left}px`, bottom: `${placement.bottom}px` }}
          onClick={onPanelClick} onKeyDown={onPopoverKeyDown}>
          {content}
        </div>,
        document.body,
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

/** What counts as a control in the popover, for where focus lands on open and for its Tab edges. */
const FOCUSABLE = 'a[href], button:not(:disabled)'

/** The gap between the icon and the popover, and the popover's least distance from a viewport edge. */
const GAP_PX = 6

export interface Placement { left: number, bottom: number }

/**
 * Where the fixed popover goes, as a left edge and a distance from the viewport's bottom.
 *
 * Bottom rather than top, because the popover opens upward and its height is its content's: pinned
 * by its bottom edge it grows away from the icon, which is how .rail-menu opens beside it. An
 * expanded rail puts it above the icon, its left edge on the rail foot's so it lines up with the
 * name beside it. A collapsed rail is a 60px strip with no room above for anything 20rem wide, so
 * it opens past the strip's right edge - the rail's, not the icon's, which sits inside the strip's
 * padding and would leave the popover lying over the strip's last 16px - its bottom level with the
 * icon's.
 *
 * Clamped both ways into the viewport by GAP_PX: pulled left when a narrow window would push it
 * off the right edge, and pinned below the top when it is taller than the room above the icon
 * (max-height: 70vh caps it, but a short window can still make 70vh more than there is).
 */
export function placementFor({ trigger, anchorLeft, stripRight, collapsed, size, viewport }: {
  trigger: { left: number, top: number, right: number, bottom: number }
  /** Where an expanded rail's popover starts: the rail foot's left edge. */
  anchorLeft: number
  /** Where a collapsed rail's strip ends: the rail's right edge. */
  stripRight: number
  collapsed: boolean
  size: { width: number, height: number }
  viewport: { width: number, height: number }
}): Placement {
  const left = collapsed ? stripRight + GAP_PX : anchorLeft
  const bottom = collapsed ? viewport.height - trigger.bottom : viewport.height - trigger.top + GAP_PX
  return {
    // Near edge first, then the far one, so when both cannot hold the far one wins: the right
    // edge over the left, the top over the bottom. A popover cut at the top loses its first
    // connection, the one a reader opened it to see.
    left: Math.min(Math.max(GAP_PX, left), viewport.width - size.width - GAP_PX),
    bottom: Math.min(Math.max(GAP_PX, bottom), viewport.height - size.height - GAP_PX),
  }
}
