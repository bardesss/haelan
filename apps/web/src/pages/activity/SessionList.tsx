import { useMemo, useState } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { useSessions } from '../../data/useSessions.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { formatDuration, formatSessionDateHeading } from '../../format.js'
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
 * A day's total time, from the same start and end each row's own duration comes from.
 *
 * Elapsed rather than moving time: only some sessions record a moving duration, so summing that
 * would give a day total measuring something different from the rows beneath it, and lower than
 * their visible sum for a reason a reader cannot see.
 */
function totalMinutes(sessions: readonly WorkoutSession[]): number {
  return sessions.reduce((total, s) => total + Math.round((s.endMs - s.startMs) / 60_000), 0)
}

/**
 * The section 192 real exercise sessions had no surface for: a list below Activity's tiles and
 * heatmap, grouped by day and filtered by a type picker built from what the range actually holds.
 * The page itself scrolls to reach it; this list carries no scroll container of its own. Handles
 * its three query states by hand (isError, isPending, then the list) for the same reason the
 * Dashboard's flagged days card does: a session carries no metric and no points, so there is no
 * MetricCard to gate on.
 */
export function SessionList({ controls }: { controls: PageControlsState }) {
  const { t, i18n } = useTranslation()
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
  // A chosen type the range no longer holds stays listed. resolveSource answers the same problem
  // for the source picker by falling the value back to the sentinel (controls/source.ts), and
  // that answer is not open here: falling back would silently turn "no sessions of this type"
  // into "here is the period again", collapsing the two claims the unreset selection above exists
  // to keep apart. Listing the orphan instead keeps both, and gives the select an option matching
  // its own controlled value, which is what stops a browser from quietly showing the first option
  // ("All types") over rows a different type is filtering.
  const options = useMemo(() => {
    if (selectedType === ALL_TYPES) return typeOptions
    if (typeOptions.some((option) => option.value === selectedType)) return typeOptions
    const label = exerciseTypeLabel(t, selectedType === UNKNOWN_TYPE ? null : selectedType)
    return [...typeOptions, { value: selectedType, label }].sort((a, b) => a.label.localeCompare(b.label))
  }, [typeOptions, selectedType, t])

  // A filter of one option is not a filter: ControlRow already applies this ruling to the source
  // picker on Notes (sources={[]} there), and a range that holds exactly one exercise type is the
  // same case here. A filter already narrowing the rows is the exception, whatever the range now
  // holds: without the second clause a reader who steps into a single type period with a
  // different type selected sees no select, no rows, and a message telling them to choose another
  // type with nothing to choose with.
  const hasTypeFilter = options.length > 1 || selectedType !== ALL_TYPES

  const filtered = selectedType === ALL_TYPES
    ? typed.map((entry) => entry.session)
    : typed.filter((entry) => (entry.type ?? UNKNOWN_TYPE) === selectedType).map((entry) => entry.session)

  // Five sessions on one day used to print their own date five times ("do 27 aug" x5). This
  // partitions `filtered` into runs of a shared localDate rather than sorting or bucketing it
  // fresh, which is what keeps grouping from reordering anything: `filtered` is already
  // newest-first, and a partition of a list preserves that list's own order both inside and
  // across the runs it produces.
  const groups = useMemo(() => {
    const result: { date: string, sessions: WorkoutSession[] }[] = []
    for (const session of filtered) {
      const last = result[result.length - 1]
      if (last !== undefined && last.date === session.localDate) last.sessions.push(session)
      else result.push({ date: session.localDate, sessions: [session] })
    }
    return result
  }, [filtered])

  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} error={query.error} />
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
    <div className="session-list list-measured">
      <div className="session-list-header">
        {/* Unfiltered the count states the period, which is what "in this period" claims. A
            filter does not narrow that claim, it changes it: the shown figure alone would say a
            four session month held one, and in the filtered-empty branch would read "0 recorded
            sessions in this period" directly above a message offering to show the rest of the
            period's sessions. Both figures, so neither sentence contradicts the other. */}
        <span className="session-list-count">
          {selectedType === ALL_TYPES
            ? t('activity.sessions.count', { count: items.length })
            : t('activity.sessions.countFiltered', { shown: filtered.length, total: items.length })}
        </span>
        {hasTypeFilter && (
          <label className="button">
            <span className="sr-only">{t('activity.sessions.filterLabel')}</span>
            <select value={selectedType} onChange={(e) => setSelectedType(e.currentTarget.value)}>
              <option value={ALL_TYPES}>{t('activity.sessions.allTypes')}</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {/* The Workouts tile at the top of this page sums merged `daily` workout_count, which
          deriveExerciseDay writes from groupSessions: the same run recorded by a watch and a
          phone is one workout there and two rows here. Over the reporting household's seven
          months that is 186 against 192, differing on six days, so on an all sources Month the
          tile can sit lower than the rows beneath it. The two are different quantities, and this
          line is what says so, since nothing else on the page distinguishes them. */}
      <p className="basis">{t('activity.sessions.basis')}</p>
      {filtered.length === 0 ? (
        <EmptyState title={t('activity.sessions.emptyFilteredTitle', { type: selectedLabel })}
          detail={t('activity.sessions.emptyFilteredDetail')} />
      ) : (
        // No scroll container here any more: the page around this card already scrolls, so a
        // second scrollbar inside it only trapped the wheel and clipped the first row. Each
        // group is a run of same-day rows under one heading (built above in `groups`); SessionRow
        // itself stops printing the date now that this heading carries it.
        <div className="session-groups">
          {groups.map((group, index) => (
            // Composite, not group.date alone: the partition above groups CONSECUTIVE same-date
            // rows, and consecutive is not the same guarantee as unique. Two sources can log the
            // same calendar day with different UTC offsets, which can interleave that day's rows
            // with a different date's under startMs order and split it into two non-adjacent runs
            // sharing one date, so group.date is usually unique across groups but not by
            // construction. index always is.
            <div key={`${group.date}-${index}`} className="session-date-group">
              {/* The count and the total were there to be added up by hand, which is what a reader
                  scanning a week was doing. Elapsed time, the same figure each row already shows,
                  summed - not moving time, which only some sessions record and which would make
                  the day total mean something different from the rows beneath it. */}
              <h3 className="session-date-heading">
                <span className="session-date-label">{formatSessionDateHeading(group.date, i18n.language)}</span>
                <span className="session-day-summary">
                  {t('activity.sessions.daySummary', {
                    count: group.sessions.length,
                    duration: formatDuration(totalMinutes(group.sessions)),
                  })}
                </span>
              </h3>
              {group.sessions.map((session) => <SessionRow key={session.id} session={session} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
