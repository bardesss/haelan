import { useMemo, useState } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { useSessions } from '../../data/useSessions.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { workoutSummary } from '../../data/workoutSummary.js'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { SessionRow } from './SessionRow.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { EmptyState } from '../../components/EmptyState.js'
import type { PageControlsState } from '../../controls/usePageControls.js'

// The sentinel for "every type", kept out of the option list's own values so it can never collide
// with a real exerciseType (every real one is an uppercase provider constant; see
// SEEDED_EXERCISE_TYPES in exerciseTypeLabel.ts).
const ALL_TYPES = '__all__'
// exerciseType is null on a session workoutSummary could not read one from; grouped under this
// sentinel rather than dropped, since exerciseTypeLabel(t, null) already has a real word for it
// ("Unknown"/"Onbekend") and a session with no type is still a session a reader should be able to
// see or filter out.
const UNKNOWN_TYPE = '__unknown__'

/**
 * The section 192 real exercise sessions had no surface for: a scrolling list below Activity's
 * tiles and heatmap, filtered by a type picker built from what the range actually holds. Handles
 * its three query states by hand (isError, isPending, then the list) for the same reason the
 * Dashboard's flagged days card does: a session carries no metric and no points, so there is no
 * MetricCard to gate on.
 */
export function SessionList({ controls }: { controls: PageControlsState }) {
  const { t } = useTranslation()
  // Local, not URL, state: this is a view of one section on the page, not a dimension the page's
  // own range, source or export cares about. Not reset when the query answers again (a new sync,
  // a stepped period): a selection outliving the data it was built from is what lets "no sessions
  // of this type" and "no sessions in this period" stay two different, honest claims rather than
  // one silently falling back to the other.
  const [selectedType, setSelectedType] = useState<string>(ALL_TYPES)

  const query = useSessions({ kind: 'exercise', from: controls.from, to: controls.to, source: controls.source })

  // The route answers ascending by startMs (sessions.ts's own comment, there to keep a snapshot's
  // order deterministic), which is the opposite of what a reader wants first.
  const items = useMemo(() => {
    const rows = query.data?.items ?? []
    return [...rows].sort((a, b) => b.startMs - a.startMs)
  }, [query.data])

  // Each row's type read once here, not once per render inside the filter and again inside the
  // option list: workoutSummary is the only reader allowed to open a session's attrs, and doing
  // that twice per session for the same answer is pointless work at 190 rows.
  const typed = useMemo(
    () => items.map((session): { session: WorkoutSession, type: string | null } =>
      ({ session, type: workoutSummary(session.attrs).exerciseType })),
    [items],
  )

  // Distinct types the range actually holds, not the 182 the catalogue declares, sorted by their
  // translated label so the picker's order matches what a reader sees rather than the enum's own
  // order.
  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const { type } of typed) {
      const value = type ?? UNKNOWN_TYPE
      if (!seen.has(value)) seen.set(value, exerciseTypeLabel(t, type))
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [typed, t])
  // A filter of one option is not a filter: ControlRow already applies this ruling to the source
  // picker on Notes (sources={[]} there), and a range that holds exactly one exercise type is the
  // same case here.
  const hasTypeFilter = typeOptions.length > 1

  const filtered = selectedType === ALL_TYPES
    ? typed.map((entry) => entry.session)
    : typed.filter((entry) => (entry.type ?? UNKNOWN_TYPE) === selectedType).map((entry) => entry.session)

  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  if (query.isPending) return <Loading />

  // An empty range and a filter matching nothing are different claims with different remedies
  // (wait or sync, against choose another type), so they read as two different sentences rather
  // than one printed over both causes. This branch is the first of the two: nothing was fetched
  // for this period at all, so there is no filter to blame and none is offered.
  if (items.length === 0) {
    return <EmptyState title={t('activity.sessions.emptyPeriodTitle')} detail={t('activity.sessions.emptyPeriodDetail')} />
  }

  // Only reached once selectedType names a real type (the branch above returns for items.length
  // === 0, and filtered.length can only be 0 with selectedType !== ALL_TYPES: with ALL_TYPES,
  // filtered is items itself, already known non-empty here).
  const selectedLabel = selectedType === ALL_TYPES
    ? ''
    : exerciseTypeLabel(t, selectedType === UNKNOWN_TYPE ? null : selectedType)

  return (
    <div className="session-list">
      <div className="session-list-header">
        {/* The count is stated because a scroll container hides its own length: a reader looking
            at a fixed-height list of rows has no other way to tell fifteen rows from all of
            fifteen. Counts what is actually shown, not the period's full total, so it stays true
            once a filter narrows the rows underneath it. */}
        <span className="session-list-count">
          {t('activity.sessions.count', { count: filtered.length })}
        </span>
        {hasTypeFilter && (
          <label className="button">
            <span className="sr-only">{t('activity.sessions.filterLabel')}</span>
            <select value={selectedType} onChange={(e) => setSelectedType(e.currentTarget.value)}>
              <option value={ALL_TYPES}>{t('activity.sessions.allTypes')}</option>
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {filtered.length === 0 ? (
        <EmptyState title={t('activity.sessions.emptyFilteredTitle', { type: selectedLabel })}
          detail={t('activity.sessions.emptyFilteredDetail')} />
      ) : (
        <div className="session-list-scroll">
          {filtered.map((session) => <SessionRow key={session.id} session={session} />)}
        </div>
      )}
    </div>
  )
}
