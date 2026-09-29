import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { useIsPhone } from '../ui/breakpoint.js'
import { formatHeaderDate } from '../pages/dashboard/glanceText.js'
import { Link } from '../router.js'
import { StepArrows } from './StepArrows.js'

// A plain calendar date, the only thing formatHeaderDate can read: a hand-typed URL can put
// anything in a detail page's date segment, and Intl throws on the Invalid Date it would make.
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A date as a page's title: the long form ("Saturday, September 5"), and on a phone the short one
 * ("Sat, Sep 5"), since the long one wrapped to three lines beside the header's buttons and the
 * header is one line there (spec M9c, "Phone"). Null for no date, or for one that is not a date.
 */
export function useHeaderDate(localDate: string | null | undefined): string | null {
  const { i18n } = useTranslation()
  const isPhone = useIsPhone()
  if (localDate === null || localDate === undefined || !LOCAL_DATE.test(localDate)) return null
  if (Number.isNaN(Date.parse(`${localDate}T00:00:00Z`))) return null
  return formatHeaderDate(localDate, i18n.language, isPhone)
}

/**
 * A page's header row (Dashboard.tsx's, shared with the detail pages by the M10a sweep): the title
 * and its line on the left, the page's navigator on the right. One row at every width, which on a
 * phone stays one row, the title ending in an ellipsis inside its own column rather than pushing
 * the buttons onto a second line (app.css's .dash-title rule). The class names stay the
 * dashboard's, since this is the dashboard's header, now reached from more than one page.
 */
export function PageHeader({ title, line, nav }: { title: ReactNode, line?: ReactNode, nav?: ReactNode }) {
  return (
    <div className="dash-header">
      <div className="dash-heading">
        <h1 className="dash-title">{title}</h1>
        {line !== undefined && <p className="dash-date">{line}</p>}
      </div>
      {nav}
    </div>
  )
}

/**
 * A detail page's navigator, the dashboard's DayNav in the shape a detail page needs: ‹ › to the
 * neighbours the page's own payload names (StepArrows), then the way back to the list the page was
 * opened from, a `.button` in the same row where the dashboard has its Today button, so the row
 * never wraps and every control in it is the same height.
 *
 * `previous` and `next` are null while the page has no payload to name them (loading, a date with
 * nothing on it, a failed read): both arrows disabled rather than hidden, so the row keeps its
 * shape and the way back is still there.
 */
export function DetailNav({ label, previous, next, onPick, labels, back }: {
  label: string
  previous: string | null
  next: string | null
  onPick: (target: string) => void
  labels: { previous: string, next: string }
  back: { to: string, text: string }
}) {
  return (
    <div className="day-nav" role="group" aria-label={label}>
      <StepArrows previous={previous} next={next} onPick={onPick} labels={labels} />
      <Link to={back.to} className="button day-nav-back">{back.text}</Link>
    </div>
  )
}
