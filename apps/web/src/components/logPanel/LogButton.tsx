import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../i18n/index.js'
import { useIsPhone } from '../../ui/breakpoint.js'
import { placementFor } from '../../ui/placement.js'
import type { Placement } from '../../ui/placement.js'
import type { GlanceLog } from '../../data/useGlance.js'
import { LogPanel } from './LogPanel.js'

// Everything in the panel Tab can land on: its buttons, the add field and the note, and the chip
// editor's kinds (tabIndex 0). The ‹ › buttons count while aria-disabled, which keeps them focusable.
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'

/**
 * The log panel in its container (M9c, "The log panel"): a popover under the Log button on a
 * desktop, a bottom sheet on a phone. GlanceCalendar.tsx is the model for both, and the comments
 * there explain the parts repeated here; what differs is said where it differs.
 *
 * The panel keeps its own day, starting on the day the dashboard shows: ‹ › inside it log for
 * another day without moving the page behind it. The dashboard's `log` is the shown day's, so it
 * seeds the panel only while the panel is on that day; any other day loads its own.
 */
function LogLayer({ shownDay, today, log, anchor, onClose }: {
  shownDay: string
  today: string
  log: GlanceLog | undefined
  anchor: HTMLElement | null
  onClose: () => void
}) {
  const isPhone = useIsPhone()
  const titleId = useId()
  const [day, setDay] = useState(shownDay)
  const layer = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Under the button, its left edge on the button's (the calendar anchors its right edge; the Log
  // button leads the row, so its panel opens rightward over the page), kept in the viewport by
  // placementFor. Measured again on resize and whenever the panel's height changes: a stepped day
  // loads, and the chip editor is taller than the chips.
  useLayoutEffect(() => {
    if (isPhone) { setPlacement(null); return }
    const place = () => {
      if (anchor === null) return
      const rect = anchor.getBoundingClientRect()
      const box = layer.current?.getBoundingClientRect()
      const next = placementFor({
        trigger: rect, anchorLeft: rect.left, stripRight: rect.right, collapsed: false, below: true,
        size: { width: box?.width ?? 0, height: box?.height ?? 0 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      setPlacement((current) => current !== null && current.left === next.left && current.bottom === next.bottom ? current : next)
    }
    place()
    window.addEventListener('resize', place)
    const box = layer.current
    const observer = box !== null && typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    if (box !== null) observer?.observe(box)
    return () => {
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [isPhone, anchor])

  // Escape and a press outside, for the popover. An Escape already claimed is left alone: the chip
  // editor claims the one that leaves edit mode (PresetEditor's own comment), and that one must not
  // take the popover with it.
  useEffect(() => {
    if (isPhone) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (anchor?.contains(target) === true || layer.current?.contains(target) === true)) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [isPhone, anchor])

  // Whether the Escape being dispatched was claimed inside the sheet. The dialog's own Escape is
  // a cancel event fired after the keydown, and a browser fires it even for a keydown something
  // only stopped (the add field clearing its draft), so the sheet decides for itself: set as the key
  // passes the dialog on its way in, cleared by the dialog's onKeyDown if it comes back out
  // unclaimed. The timer drops a claim no cancel followed, so a later back gesture (a cancel with no
  // key before it) still closes the sheet.
  const escapeClaimed = useRef(false)

  // The sheet opens as it mounts, and its own close event (Escape, the backdrop, ✕) tells the button
  // it has gone.
  useEffect(() => {
    const element = sheet.current
    if (!isPhone || !element) return
    if (!element.open) element.showModal()
    const onSheetClose = () => closeRef.current()
    const onKeyIn = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      escapeClaimed.current = true
      setTimeout(() => { escapeClaimed.current = false }, 0)
    }
    const onCancel = (event: Event) => {
      if (escapeClaimed.current) event.preventDefault()
      escapeClaimed.current = false
    }
    element.addEventListener('close', onSheetClose)
    element.addEventListener('keydown', onKeyIn, true)
    element.addEventListener('cancel', onCancel)
    return () => {
      element.removeEventListener('close', onSheetClose)
      element.removeEventListener('keydown', onKeyIn, true)
      element.removeEventListener('cancel', onCancel)
    }
  }, [isPhone])

  // Focus to the title row's first control once there is somewhere to put it (on a desktop, once
  // the popover is placed: a hidden box cannot take focus). Once only, so stepping a day or
  // re-placing the popover never pulls focus back from where the reader has taken it.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || (!isPhone && placement === null)) return
    const target = layer.current?.querySelector<HTMLElement>('.log-top button')
    if (!target) return
    target.focus({ preventScroll: true })
    focused.current = true
  })

  // Tab order as if the popover followed the button, which the portal broke (GlanceCalendar.tsx's
  // onPopoverKeyDown, after StatusControl.tsx's).
  function onPopoverKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== 'Tab') return
    const element = layer.current
    if (!element) return
    const controls = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const active = document.activeElement
    if (event.shiftKey) {
      if (active === element || active === controls[0]) {
        event.preventDefault()
        anchor?.focus({ preventScroll: true })
      }
      return
    }
    if (controls.length === 0 ? active === element : active === controls.at(-1)) onClose()
  }

  // The sheet is closed before the button hears of it: while a modal dialog is open everything
  // outside it is inert, so the trigger could not take focus back until the dialog had gone.
  // (Escape and the back gesture close it themselves, before its close event calls onClose.)
  function dismiss() {
    if (sheet.current?.open === true) sheet.current.close()
    onClose()
  }

  const panel = (
    <LogPanel day={day} today={today} {...(day === shownDay && log !== undefined ? { initial: log } : {})}
      onStep={setDay} onClose={dismiss} titleId={titleId} />
  )

  // Both containers are portalled to the body, so neither sits inside the day navigator's
  // role="group" and neither is announced as part of it.
  if (isPhone) {
    return createPortal(
      <dialog ref={sheet} className="log-sheet" data-log-panel="" aria-labelledby={titleId}
        onClick={(event) => { if (event.target === sheet.current) dismiss() }}
        onKeyDown={(event) => { if (event.key === 'Escape') escapeClaimed.current = false }}>
        <div ref={layer} className="log-sheet-body">
          <span className="log-grab" aria-hidden="true" />
          {panel}
        </div>
      </dialog>,
      document.body,
    )
  }

  return createPortal(
    <div ref={layer} className="log-popover" data-log-panel="" role="dialog" aria-labelledby={titleId} tabIndex={-1}
      style={placement === null ? { visibility: 'hidden' } : { left: `${placement.left}px`, bottom: `${placement.bottom}px` }}
      onKeyDown={onPopoverKeyDown}>
      {panel}
    </div>,
    document.body,
  )
}

/**
 * The dashboard's Log button (DayNav's `logButton`), owning whether the panel is open. Rendered
 * only while quick logging is on, which the Dashboard reads off the glance carrying a `log`.
 *
 * At phone width the label is hidden by app.css and the button is a + in a 44px square shaped like
 * the day arrows: the labelled button truncated the greeting beside it. The label stays in the tree, so the
 * button's name is still "Log" there.
 *
 * `log` is undefined while the dashboard is loading the day it names (the glance on screen is still
 * the previous day's), and the panel then loads the day itself.
 */
export function LogButton({ shownDay, today, log }: {
  shownDay: string
  today: string
  log: GlanceLog | undefined
}) {
  const { t } = useTranslation()
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  function close() {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  // Tab off the button leaves the popover behind, as CalendarButton's does.
  function onTriggerKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Tab' && open && !isPhone) setOpen(false)
  }

  return (
    <>
      <button ref={trigger} type="button" className="button button-primary log-btn"
        aria-haspopup={isPhone ? 'dialog' : 'true'} aria-expanded={open}
        onClick={() => setOpen((current) => !current)} onKeyDown={onTriggerKeyDown}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="log-btn-label">{t('logPanel.open')}</span>
      </button>
      {open && <LogLayer shownDay={shownDay} today={today} log={log} anchor={trigger.current} onClose={close} />}
    </>
  )
}
