import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../../components/icons.js'
import { useIsPhone } from '../../ui/breakpoint.js'
import { placementFor } from '../../ui/placement.js'
import type { Placement } from '../../ui/placement.js'
import { useGlanceCalendar } from '../../data/useGlanceCalendar.js'
import type { CalendarSleep, CalendarSteps, GlanceCalendarDay } from '../../data/useGlanceCalendar.js'
import { formatLongDate } from './glanceText.js'

// Day and month arithmetic on the local-date strings the server speaks, read and written as UTC so
// no zone offset can move a date by one.
function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}
function shiftMonth(month: string, n: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, index - 1 + n, 1)).toISOString().slice(0, 7)
}
function daysIn(month: string): number {
  const [year, index] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, index, 0)).getUTCDate()
}
/** Monday 0 to Sunday 6: the calendar's weeks start on a Monday. */
function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}
const pad = (n: number) => String(n).padStart(2, '0')
const clampDay = (month: string, dayOfMonth: number) => `${month}-${pad(Math.min(dayOfMonth, daysIn(month)))}`

/** The month's weeks, Monday first, with null for the days of the neighbouring months. */
function weeksOf(month: string): (string | null)[][] {
  const cells: (string | null)[] = Array.from({ length: weekdayIndex(`${month}-01`) }, () => null)
  for (let d = 1; d <= daysIn(month); d++) cells.push(`${month}-${pad(d)}`)
  while (cells.length % 7 !== 0) cells.push(null)
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
}

// Class lists by state, looked up rather than assembled, so every name here is one app.css styles
// (css-classes.test.ts reads them as written).
const DAY_CLASS = {
  off: 'cal-day is-off',
  selectedToday: 'cal-day is-selected is-today',
  selected: 'cal-day is-selected',
  today: 'cal-day is-today',
  plain: 'cal-day',
} as const
const SLEEP_DOT = { within: 'cal-dot is-within', outside: 'cal-dot is-outside', none: 'cal-dot is-none' } as const
const STEPS_DOT = { reached: 'cal-dot is-reached', below: 'cal-dot is-below', none: 'cal-dot is-none' } as const
const sleepDot = (sleep: CalendarSleep) => SLEEP_DOT[sleep ?? 'none']
const stepsDot = (steps: CalendarSteps) => STEPS_DOT[steps ?? 'none']

/** What counts as a control in the popover, for its Tab edges. */
const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"])'

/**
 * The dashboard's calendar (M9c, "The calendar (C2)"): a month of days, each day with data carrying
 * two dots - last night's sleep against its usual range on the left, the day's steps against their
 * usual on the right - and every other day grey.
 *
 * The dots are the server's verdicts (GET /glance/calendar), never judged here, so the calendar
 * cannot disagree with the cards it opens. What this component does decide is which days can be
 * picked: those the server lists, but never one after `today` or before `firstDay`, so a listing
 * that ever strayed past either edge still could not open a day the glance route would refuse.
 *
 * A grid with one tab stop (roving tabIndex): the arrows move a day or a week, PageUp and PageDown
 * a month, Home and End to the week's ends. A move that lands on a grey day carries on in the same
 * direction to the next day that has data, crossing into the neighbouring month when this one has
 * none left that way and that month is reachable; with nowhere to go, focus stays where it was.
 * Grey days stay in the grid as disabled buttons (aria-disabled, out of the tab order) so a screen
 * reader walking the table hears them as unavailable rather than as holes.
 *
 * A popover under the calendar button on a desktop, portalled and placed by placementFor as the
 * status popover is (StatusControl.tsx, whose comments give the reasons); a bottom sheet on a phone,
 * a <dialog> like the status panel's, where a popover off a 44px header button has no room.
 */
export function GlanceCalendar({ selected, today, onPick, onClose, anchor }: {
  selected: string
  today: string
  onPick: (day: string) => void
  onClose: () => void
  anchor: HTMLElement | null
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const isPhone = useIsPhone()
  const titleId = useId()

  const [month, setMonth] = useState(selected.slice(0, 7))
  // Where focus is headed: a day, and the direction to carry on in if it turns out grey. Held as
  // intent rather than as the focused day, because a move into another month is made before that
  // month's days have arrived to say which of them can take focus.
  const [cursor, setCursor] = useState<{ day: string, dir: 1 | -1 }>({ day: selected, dir: 1 })
  const { calendar } = useGlanceCalendar(month)
  const loaded = calendar !== undefined && calendar.month === month ? calendar : undefined

  // The first day with data is the archive's, not the month's, so it is remembered across months:
  // a month still loading keeps the ‹ arrow's answer from the last one.
  const firstDayRef = useRef<string | null | undefined>(undefined)
  if (loaded !== undefined) firstDayRef.current = loaded.firstDay
  const firstDay = firstDayRef.current
  const firstMonth = firstDay === undefined || firstDay === null ? null : firstDay.slice(0, 7)
  const lastMonth = today.slice(0, 7)
  const reachable = (m: string) => firstMonth !== null && m >= firstMonth && m <= lastMonth

  const days = useMemo(() => {
    const enabled = new Map<string, GlanceCalendarDay>()
    if (loaded === undefined) return enabled
    for (const entry of loaded.days) {
      if (entry.localDate > today) continue
      if (loaded.firstDay !== null && entry.localDate < loaded.firstDay) continue
      enabled.set(entry.localDate, entry)
    }
    return enabled
  }, [loaded, today])

  /** The first day with data from `from` going `dir`, inside this month, or null. */
  const scan = (from: string, dir: 1 | -1): string | null => {
    for (let d = from; d.slice(0, 7) === month; d = addDays(d, dir)) if (days.has(d)) return d
    return null
  }
  const focusDay = loaded === undefined || cursor.day.slice(0, 7) !== month
    ? null
    : scan(cursor.day, cursor.dir) ?? scan(cursor.day, cursor.dir === 1 ? -1 : 1)

  // Set by a keyboard move (and by opening), cleared once the day it was for has taken focus, so a
  // click on a month arrow leaves focus on the arrow rather than pulling it into the grid.
  const wantFocus = useRef(true)

  // Where a key moves from: the focused day, or in a month with no day to focus, the day the cursor
  // was headed for, so the keys still page on past an empty month rather than stranding focus.
  const moveFrom = focusDay ?? (loaded === undefined ? null : cursor.day)

  function move(target: string, dir: 1 | -1) {
    if (moveFrom === null) return
    const targetMonth = target.slice(0, 7)
    if (targetMonth !== month) {
      if (!reachable(targetMonth)) return
      wantFocus.current = true
      setMonth(targetMonth)
      setCursor({ day: target, dir })
      return
    }
    const found = scan(target, dir)
    if (found !== null) {
      wantFocus.current = true
      setCursor({ day: found, dir })
      return
    }
    const next = shiftMonth(month, dir)
    if (!reachable(next)) return
    wantFocus.current = true
    setMonth(next)
    setCursor({ day: dir === 1 ? `${next}-01` : clampDay(next, 31), dir })
  }

  function showMonth(next: string) {
    setMonth(next)
    setCursor(next === selected.slice(0, 7) ? { day: selected, dir: 1 } : { day: `${next}-01`, dir: 1 })
  }

  function pick(day: string) {
    onPick(day)
    onClose()
  }

  function onGridKeyDown(event: React.KeyboardEvent) {
    if (moveFrom === null) return
    const dayOfMonth = Number(moveFrom.slice(8))
    const weekday = weekdayIndex(moveFrom)
    switch (event.key) {
      case 'ArrowLeft': move(addDays(moveFrom, -1), -1); break
      case 'ArrowRight': move(addDays(moveFrom, 1), 1); break
      case 'ArrowUp': move(addDays(moveFrom, -7), -1); break
      case 'ArrowDown': move(addDays(moveFrom, 7), 1); break
      case 'PageUp': move(clampDay(shiftMonth(month, -1), dayOfMonth), -1); break
      case 'PageDown': move(clampDay(shiftMonth(month, 1), dayOfMonth), 1); break
      // The week's ends, held inside the month, carrying on back toward the day focus came from
      // when the end itself is grey. That day is in this week row and has data, so the scan stops
      // on it at the latest and never crosses into the next or previous week (hence the direction:
      // Home scans forward, End back). Nothing to do in a month with no day to land on.
      case 'Home': if (focusDay !== null) move(`${month}-${pad(Math.max(1, dayOfMonth - weekday))}`, 1); break
      case 'End': if (focusDay !== null) move(`${month}-${pad(Math.min(daysIn(month), dayOfMonth + 6 - weekday))}`, -1); break
      case 'Enter': case ' ': if (focusDay !== null) pick(focusDay); break
      default: return
    }
    event.preventDefault()
  }

  const layer = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Where the popover goes: under the button, its right edge on the button's, kept inside the
  // viewport by placementFor. Measured before paint, again on resize and whenever its own size
  // changes (a month of six weeks is taller than one of five), for StatusControl's reasons.
  useLayoutEffect(() => {
    if (isPhone) { setPlacement(null); return }
    const place = () => {
      if (anchor === null) return
      const rect = anchor.getBoundingClientRect()
      const box = layer.current?.getBoundingClientRect()
      const width = box?.width ?? 0
      const next = placementFor({
        trigger: rect, anchorLeft: rect.right - width, stripRight: rect.right, collapsed: false, below: true,
        size: { width, height: box?.height ?? 0 },
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

  // Escape and a press outside, for the popover; the sheet is a <dialog> and has both of its own.
  // Escape is claimed so a layer beneath does not close with it. The button counts as inside, so
  // pressing it again is its own toggle rather than a close followed by a reopen.
  useEffect(() => {
    if (isPhone) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
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

  // The sheet opens as it mounts, and its own close event (Escape, the backdrop, the close button)
  // is what tells the button it has gone.
  useEffect(() => {
    const element = sheet.current
    if (!isPhone || !element) return
    if (!element.open) element.showModal()
    const onSheetClose = () => closeRef.current()
    element.addEventListener('close', onSheetClose)
    return () => element.removeEventListener('close', onSheetClose)
  }, [isPhone])

  // Focus to the day it is headed for, once there is somewhere to put it: the month has arrived,
  // and on a desktop the popover has been placed (a hidden box cannot take focus).
  useEffect(() => {
    if (!wantFocus.current || loaded === undefined || (!isPhone && placement === null)) return
    // A month with no pickable day focuses the grid itself, the one tab stop it then has, so focus
    // is never left on the button (on open) or dropped to the body (after a key into the month).
    const target = focusDay === null
      ? layer.current?.querySelector<HTMLElement>('.cal-grid')
      : layer.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)
    if (!target) return
    target.focus({ preventScroll: true })
    wantFocus.current = false
  })

  // Tab order as if the popover followed the button, which the portal broke (StatusControl.tsx's
  // onPopoverKeyDown explains the three edges): Shift+Tab off the first control goes back to the
  // button, Tab off the last closes the popover and lets the browser step on from the button.
  function onPopoverKeyDown(event: React.KeyboardEvent) {
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

  const monthTitle = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`))
  const weekdays = useMemo(() => {
    const short = new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' })
    const long = new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' })
    // 7 September 2026 is a Monday.
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 7 + i))
      return { initials: short.format(date).slice(0, 2), name: long.format(date) }
    })
  }, [language])

  function dayName(day: string, entry: GlanceCalendarDay | undefined): string {
    const date = formatLongDate(day, language)
    if (entry === undefined) return t('glance.calendar.noData', { date })
    return t('glance.calendar.day', {
      date,
      sleep: t(`glance.calendar.spokenSleep.${entry.sleep ?? 'none'}`),
      steps: t(`glance.calendar.spokenSteps.${entry.steps ?? 'none'}`),
    })
  }

  function dayClass(day: string, on: boolean): string {
    if (!on) return DAY_CLASS.off
    if (day === selected) return day === today ? DAY_CLASS.selectedToday : DAY_CLASS.selected
    return day === today ? DAY_CLASS.today : DAY_CLASS.plain
  }

  const body = (
    <>
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label={t('glance.calendar.previousMonth')}
          disabled={!reachable(shiftMonth(month, -1))} onClick={() => showMonth(shiftMonth(month, -1))}>
          <Icon name="chevronLeft" />
        </button>
        <span className="cal-title" id={titleId} aria-live="polite">{monthTitle}</span>
        <button type="button" className="cal-nav" aria-label={t('glance.calendar.nextMonth')}
          disabled={!reachable(shiftMonth(month, 1))} onClick={() => showMonth(shiftMonth(month, 1))}>
          <Icon name="chevronRight" />
        </button>
      </div>
      <div className="cal-grid" role="grid" aria-labelledby={titleId} aria-busy={loaded === undefined}
        tabIndex={loaded !== undefined && focusDay === null ? 0 : undefined} onKeyDown={onGridKeyDown}>
        <div className="cal-weekdays" role="row">
          {weekdays.map((w) => (
            <span key={w.name} className="cal-weekday" role="columnheader" aria-label={w.name}>{w.initials}</span>
          ))}
        </div>
        {weeksOf(month).map((week, w) => (
          <div key={w} className="cal-week" role="row">
            {week.map((d, i) => {
              if (d === null) return <div key={`blank-${i}`} className="cal-cell" role="gridcell" />
              const entry = days.get(d)
              const on = entry !== undefined
              return (
                <div key={d} className="cal-cell" role="gridcell" aria-selected={on ? d === selected : undefined}>
                  <button type="button" data-day={d} className={dayClass(d, on)}
                    tabIndex={d === focusDay ? 0 : -1} aria-disabled={on ? undefined : true}
                    aria-label={dayName(d, entry)}
                    onClick={() => { if (on) pick(d) }}>
                    <span className="cal-num" aria-hidden="true">{Number(d.slice(8))}</span>
                    {on && (
                      <span className="cal-dots" aria-hidden="true">
                        <span className={sleepDot(entry.sleep)} />
                        <span className={stepsDot(entry.steps)} />
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="cal-legend">
        {/* Which of a day's two dots a row describes is drawn, not written: a small pair with that
            dot lit. Hidden from assistive tech, which hears every day's dots in words already. */}
        <p className="cal-legend-line">
          <span className="cal-legend-pair" aria-hidden="true"><span className="cal-pair-dot is-lit" /><span className="cal-pair-dot" /></span>
          <b className="cal-legend-name">{t('glance.calendar.sleepLegend')}</b>{' '}
          <span className="cal-legend-keys">
            <span className="cal-key"><span className="cal-dot is-within" />{t('glance.calendar.sleepWithin')}</span>{' '}
            <span className="cal-key"><span className="cal-dot is-outside" />{t('glance.calendar.sleepOutside')}</span>
          </span>
        </p>
        <p className="cal-legend-line">
          <span className="cal-legend-pair" aria-hidden="true"><span className="cal-pair-dot" /><span className="cal-pair-dot is-lit" /></span>
          <b className="cal-legend-name">{t('glance.calendar.stepsLegend')}</b>{' '}
          <span className="cal-legend-keys">
            <span className="cal-key"><span className="cal-dot is-reached" />{t('glance.calendar.stepsReached')}</span>{' '}
            <span className="cal-key"><span className="cal-dot is-below" />{t('glance.calendar.stepsBelow')}</span>
          </span>
        </p>
      </div>
      <div className="cal-foot">
        <span className="cal-note">{t('glance.calendar.greyDays')}</span>
        <button type="button" className="cal-today" onClick={() => pick(today)}>{t('glance.calendar.today')}</button>
      </div>
    </>
  )

  if (isPhone) {
    return (
      <dialog ref={sheet} className="cal-sheet" aria-label={t('glance.dayNav.calendar')}
        onClick={(event) => { if (event.target === sheet.current) onClose() }}>
        <div ref={layer} className="cal-sheet-body" data-calendar="">
          <div className="cal-sheet-head">
            <span className="cal-sheet-title">{t('glance.dayNav.calendar')}</span>
            <button type="button" className="icon-button" aria-label={t('controlRow.close')} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
          {body}
        </div>
      </dialog>
    )
  }

  return createPortal(
    <div ref={layer} className="cal-popover" data-calendar="" role="dialog" aria-label={t('glance.dayNav.calendar')} tabIndex={-1}
      style={placement === null ? { visibility: 'hidden' } : { left: `${placement.left}px`, bottom: `${placement.bottom}px` }}
      onKeyDown={onPopoverKeyDown}>
      {body}
    </div>,
    document.body,
  )
}

/**
 * The header's calendar button (DayNav's `calendarButton`), owning whether the calendar is open.
 * Every way the calendar closes - a pick, Escape, the sheet's own close - puts focus back here.
 */
export function CalendarButton({ selected, today, onPick }: {
  selected: string
  today: string
  onPick: (day: string) => void
}) {
  const { t } = useTranslation()
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  function close() {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  // Tab either way off the button leaves the calendar behind, so the popover closes rather than
  // staying open over the page with focus somewhere else. The key is not claimed: the browser steps
  // on from the button as it would with the calendar shut. The phone's sheet is modal, so the button
  // cannot take focus while it is open.
  function onTriggerKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Tab' && open && !isPhone) setOpen(false)
  }

  return (
    <>
      <button ref={trigger} type="button" className="button day-nav-btn" aria-label={t('glance.dayNav.calendar')}
        aria-haspopup={isPhone ? 'dialog' : 'true'} aria-expanded={open}
        onClick={() => setOpen((current) => !current)} onKeyDown={onTriggerKeyDown}>
        <Icon name="calendar" />
      </button>
      {open && <GlanceCalendar selected={selected} today={today} onPick={onPick} onClose={close} anchor={trigger.current} />}
    </>
  )
}
