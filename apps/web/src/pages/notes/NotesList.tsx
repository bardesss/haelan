import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import type { Translate } from '../../format.js'
import { useAnnotations, useRemoveEvent } from '../../data/useAnnotations.js'
import type { AnnotationRange, StoredEvent, StoredNote } from '../../data/useAnnotations.js'
import { SEED_KINDS } from '../../data/eventKinds.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { EmptyState } from '../../components/EmptyState.js'

/**
 * One row of the list, a note or an event flattened to the same shape. `kind` and `eventId` are
 * both null for a note row, for the same reason: a note carries neither on the wire. `eventId` is
 * what the remove cell below tests to decide whether a row gets a button at all (see the
 * `NotesList` docblock for why a note row never does).
 */
interface Row {
  id: string
  localDate: string
  kind: string | null
  text: string
  value: number | null
  eventId: string | null
}

/** An event's own `kind` is free text past the six SEED_KINDS the chart panel's datalist offers
 * (eventKinds.ts's own comment on why the column is not an enum), so only a seed kind is looked up
 * in the catalogue; anything else is the reader's own words, printed exactly as typed. */
function kindLabel(t: Translate, kind: string): string {
  return SEED_KINDS.includes(kind) ? t(`annotate.event.kinds.${kind}`) : kind
}

/**
 * Notes and events for the range, one row per item, newest day first. Two lists rather than one
 * merged query, since useAnnotations already issues them separately. Memoised by the caller on
 * the two query results, so a render triggered by something else (the range picker, a pending
 * remove) does not redo the flatten and sort below.
 *
 * The comparator reads `localDate` alone, so two rows sharing a day tie (`localeCompare` returns
 * 0), and `Array#sort`'s own stability then keeps `noteRows`, spread first, ahead of the events.
 */
function rowsFrom(t: Translate, notes: readonly StoredNote[], events: readonly StoredEvent[]): Row[] {
  const noteRows: Row[] = notes.map((n) => (
    { id: `note-${n.id}`, localDate: n.localDate, kind: null, text: n.body, value: null, eventId: null }
  ))
  const eventRows: Row[] = events.map((e) => (
    { id: `event-${e.id}`, localDate: e.localDate, kind: kindLabel(t, e.kind), text: e.note ?? '', value: e.value, eventId: e.id }
  ))
  return [...noteRows, ...eventRows].sort((a, b) => b.localDate.localeCompare(a.localDate))
}

/**
 * An event's value has no metric to look a precision up under (StoredEvent.value is whatever
 * number the reader typed into the chart panel, never a catalogue reading), so formatMetricValue
 * cannot be used. formatNumber could, with a fixed precision the way OverrideList.tsx's own
 * UNREADABLE_METRIC_PRECISION does for an unplaceable correction, but that pads a whole number
 * with fake trailing zeros ("2.00" for a plain count of 2); toLocaleString's own
 * maximumFractionDigits rounds without padding, closer to a value nothing here claims a fixed
 * precision for.
 */
function formatEventValue(value: number, language: string): string {
  return value.toLocaleString(language, { maximumFractionDigits: 2 })
}

/**
 * Every note and event for the person over `range`, newest first, with a way to remove one.
 * Notes.tsx's own counterpart to OverrideList.tsx: the same table-plus-remove-control shape, kept
 * in its own file under pages/notes/ rather than inlined in the top level page, the same layout
 * pages/settings/OverrideList.tsx already uses for the identical reason (Settings.tsx stays a thin
 * shell around it).
 *
 * A remove button only ever appears on an event row. useRemoveEvent has a real route behind it
 * (DELETE /events/:eventId) and this is its first caller; NoteStore.remove exists in core with the
 * same gap this page closes for events, but no HTTP route calls it anywhere in this build, so a
 * note row has nothing this page could send a removal request to. Rendering a button that only
 * ever hid a row locally would be exactly the failure this task exists to rule out, so a note row
 * gets `notes.removeUnavailable` instead: said on the row, not left for a reader to guess at from
 * a table where some rows can be removed and others silently cannot.
 *
 * Neither removal reports `applied`: a note or an event changes no derived number the way an
 * override does (useAnnotations.ts's own comment on invalidateResource), so there is no drain to
 * wait on and nothing for this list to say beyond a plain removed-or-not.
 */
export function NotesList({ range }: { range: AnnotationRange }) {
  const { t, i18n } = useTranslation()
  const { notes: notesQuery, events: eventsQuery } = useAnnotations(range)
  const removeEvent = useRemoveEvent()

  const isPending = notesQuery.isPending || eventsQuery.isPending
  const isError = notesQuery.isError || eventsQuery.isError
  const rows = useMemo(
    () => rowsFrom(t, notesQuery.data?.items ?? [], eventsQuery.data?.items ?? []),
    [notesQuery.data, eventsQuery.data, t],
  )

  function retry(): void {
    void notesQuery.refetch()
    void eventsQuery.refetch()
  }

  return (
    <>
      {isError ? <ErrorState onRetry={retry} />
        : isPending ? <Loading />
        : rows.length === 0 ? (
          <EmptyState title={t('notes.empty.title')} detail={t('notes.empty.detail')} />
        ) : (
          <table className="override-table">
            <caption className="sr-only">{t('notes.list.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('notes.columns.date')}</th>
                <th scope="col">{t('notes.columns.kind')}</th>
                <th scope="col">{t('notes.columns.text')}</th>
                <th scope="col">{t('notes.columns.value')}</th>
                <th scope="col"><span className="sr-only">{t('notes.columns.remove')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const removing = removeEvent.isPending && removeEvent.variables?.eventId === row.eventId
                return (
                  <tr key={row.id}>
                    <td>{row.localDate}</td>
                    <td>{row.kind ?? ''}</td>
                    <td>{row.text}</td>
                    <td className="notes-value">
                      {row.value === null ? '' : formatEventValue(row.value, i18n.language)}
                    </td>
                    <td>
                      {row.eventId !== null ? (
                        <button type="button" className="button"
                          aria-label={t('notes.removeAria', { kind: row.kind, date: row.localDate })}
                          disabled={removing}
                          onClick={() => removeEvent.mutate({ eventId: row.eventId! })}>
                          {removing ? t('notes.removing') : t('notes.remove')}
                        </button>
                      ) : (
                        // A note row: see the docblock above for why it gets this instead of a button.
                        <span className="notes-remove-unavailable">{t('notes.removeUnavailable')}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      {removeEvent.isError && <p className="form-error" role="alert">{t('notes.removeFailed')}</p>}
    </>
  )
}
