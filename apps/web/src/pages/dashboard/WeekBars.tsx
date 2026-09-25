import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { dayTooltipLines } from '../../charts/dayTooltip.js'
import { formatLongDate } from './glanceText.js'

const TONE_CLASS = { steps: 'week-bars is-steps', active: 'week-bars is-active', sleep: 'week-bars is-sleep' }

/**
 * Seven small bars, oldest first, the day shown last and highlighted; a silent day is a gap, not a
 * zero-height bar. Each bar is named in words (its long date, then "Steps 9,840", formatted the
 * way the row beside it prints its figure), so a screen reader gets the seven days the shape alone
 * draws for a sighted reader.
 *
 * With `onPick`, every bar but the day shown (`current`, which is already open) is a button that
 * opens its day. Hovering or focusing a bar shows the charts' own tooltip (M9c, "one tooltip
 * everywhere"): the same lines dayTooltip writes for a strip dot, through the same helper, in a
 * box painted with the chart tooltip's tokens, ending with "Open this day" when the bar opens it.
 * Not a native `<title>`: that was a second, unstyled tooltip beside the charts' one.
 */
export function WeekBars({ values, dates, tone, label, line, language, format, current, onPick }: {
  values: (number | null)[], dates: string[], tone: 'steps' | 'active' | 'sleep', label: string,
  /** The row's name ("Steps"), the label of the tooltip's value line. */
  line: string,
  language: string, format: (value: number) => string,
  /** The day the page shows. */
  current?: string,
  onPick?: (day: string) => void,
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState<number | null>(null)
  const [place, setPlace] = useState<{ left: number, below: boolean } | null>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const max = Math.max(1, ...values.filter((v): v is number => v !== null))

  // Placed once the tooltip has a size, before the browser paints: centred over its bar, then
  // pushed back inside the card if centring would run it past either edge, and flipped under the
  // bars when the card has no room above them (the first row, right under the card's title).
  useLayoutEffect(() => {
    const group = groupRef.current
    const tip = tipRef.current
    const bar = shown === null ? null : group?.children[shown]
    if (!group || !tip || !bar) { setPlace(null); return }
    const card = group.closest('.card') ?? group
    const g = group.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const width = tip.offsetWidth
    const centred = b.left + b.width / 2 - width / 2
    // The card's content edges, inside its padding, where every other thing on the card stops.
    const style = getComputedStyle(card)
    const inner = { left: c.left + parseFloat(style.paddingLeft || '0'), right: c.right - parseFloat(style.paddingRight || '0') }
    const left = Math.max(inner.left, Math.min(centred, inner.right - width)) - g.left
    const below = g.top - tip.offsetHeight < c.top && g.bottom + tip.offsetHeight <= c.bottom
    setPlace({ left, below })
  }, [shown])

  const hide = () => setShown(null)
  const shownDate = shown === null ? undefined : dates[shown]
  const shownValue = shown === null ? null : values[shown] ?? null
  const opens = (date: string) => onPick !== undefined && date !== current

  return (
    <div ref={groupRef} className={TONE_CLASS[tone]} role="group" aria-label={label} onMouseLeave={hide}>
      {values.map((v, i) => {
        const date = dates[i]!
        if (v === null) return <span key={date} className="week-bar-gap" />
        const words = { date: formatLongDate(date, language), label: line, value: format(v) }
        const bar = <span className={i === values.length - 1 ? 'week-bar is-today' : 'week-bar'}
          style={{ height: `${(v / max) * 100}%` }} />
        return opens(date) ? (
          <button key={date} type="button" className="week-bar-slot" aria-label={t('glance.week.openBar', words)}
            onClick={() => onPick!(date)} onMouseEnter={() => setShown(i)} onFocus={() => setShown(i)} onBlur={hide}>
            {bar}
          </button>
        ) : (
          <span key={date} className="week-bar-slot" role="img" aria-label={t('glance.week.bar', words)}
            onMouseEnter={() => setShown(i)}>
            {bar}
          </span>
        )
      })}
      {shownDate !== undefined && shownValue !== null && (
        // aria-hidden: every line of it is already the bar's own name, which is what a screen
        // reader announces on focus; reading it twice would say the day twice.
        <div ref={tipRef} className={place?.below ? 'week-bar-tip is-below' : 'week-bar-tip'} role="tooltip" aria-hidden="true"
          style={{ left: place?.left ?? 0, visibility: place === null ? 'hidden' : undefined }}>
          {[...dayTooltipLines(shownDate, line, format(shownValue), t), ...(opens(shownDate) ? [t('glance.openDay')] : [])]
            .map((text, i) => <Fragment key={i}>{i > 0 && <br />}{text}</Fragment>)}
        </div>
      )}
    </div>
  )
}
