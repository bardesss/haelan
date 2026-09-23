import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Card } from '../../components/Card.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { useAnnotations } from '../../data/useAnnotations.js'
import type { AnnotationRange } from '../../data/useAnnotations.js'
import { useTranslation } from '../../i18n/index.js'

/**
 * The flagged days card: the reader's own count of distinct days carrying an event, moved verbatim
 * (JSX and the `flaggedDates` computation both) out of Dashboard.tsx into a component both
 * Dashboard and Notes can mount. Notes.tsx's own comment says why it has no write form of its own;
 * this card is what tells a reader how many days that write path has touched over the range they
 * are looking at.
 *
 * Owns its own `useAnnotations(range)` call rather than taking events as a prop: NotesList.tsx
 * already calls `useAnnotations(range)` with the same key when this card sits on Notes, so the two
 * share one cache entry and mounting this card there costs the page no extra request. Dashboard
 * still pays its own overrides/notes/events query beside this one, one request no matter how many
 * of the three consumers on that page (chart annotations, this card, and previously nothing else)
 * end up reading from it.
 *
 * `link` is optional: Dashboard hands in a "View notes" link (this card's own deep link off the
 * page it lives on before M9b), and Notes passes none, since a reader is already on the page that
 * link would have sent them to.
 */
export function FlaggedDaysCard({ range, span, link }: {
  range: AnnotationRange
  span: number
  link?: ReactNode
}): ReactNode {
  const { t } = useTranslation()
  const { events } = useAnnotations(range)

  // "Flagged" is this card's own label for a day carrying an event, not a word AnnotatePanel
  // itself uses (its own control there is "Add an event", annotate.actions.event); a plain note
  // carries no kind or value to flag anything with, which is the actual distinction this card is
  // drawing. Distinct dates, not a count of events, since two events on one day (illness logged
  // from two different chart clicks) are one flagged day to a reader scanning a calendar, not two.
  const flaggedDates = useMemo(
    () => [...new Set((events.data?.items ?? []).map((e) => e.localDate))],
    [events.data],
  )

  // ambient: this card reads the reader's own annotations, not the period's data, so it renders on
  // a day where nothing was synced at all. Counting like any other card, it alone would hold the
  // Dashboard's tally above zero and make the page level empty state unreachable there, on the one
  // page that prompted the whole change. See Card.tsx's own prop comment. Notes uses a plain
  // `div.grid`, so `ambient` is irrelevant there, but it stays on unconditionally: it describes what
  // this card itself is, not which page happens to be counting cards around it.
  return (
    <Card span={span} ambient label={t('notes.flaggedDays.label')}>
      {events.isError ? <ErrorState onRetry={() => void events.refetch()} error={events.error} />
        : events.isPending ? <Loading />
        : flaggedDates.length === 0 ? (
          <EmptyState title={t('notes.flaggedDays.emptyTitle')} detail={t('notes.flaggedDays.emptyDetail')} />
        ) : (
          <>
            <div className="value">{flaggedDates.length}</div>
            <p className="basis">
              {t('notes.flaggedDays.basis', { count: flaggedDates.length })}
            </p>
          </>
        )}
      {link}
    </Card>
  )
}
