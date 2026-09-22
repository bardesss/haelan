import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { OverrideScope } from '@haelan/core/target-key'
import { RECOVERY_HARVEST_EVENT_KIND } from '@haelan/core/recovery-index'
import { apiGet, apiSend, ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

// Re-exported under the same name so nothing importing OverrideScope from here has to change:
// AnnotatePanel.tsx (the panel that builds target keys) added a third browser safe subpath,
// ./target-key, and packages/core/src/derive/targetKey.ts is the module that actually declares
// this union, so importing it directly replaced what used to be a by-value copy kept here because
// no such subpath existed yet.
export type { OverrideScope }

// OverrideAction has no equivalent subpath to import from: the enum lives in the overrides table
// (packages/core/src/db/schema/annotations.ts) and the route's own ACTIONS constant
// (apps/server/src/routes/v1/annotations.ts), neither reachable from a browser bundle, so this
// one is still mirrored by value rather than by import.
export type OverrideAction = 'exclude' | 'correct'

// Mirrors the three StoredNote/StoredEvent/StoredOverride rows apps/server/src/routes/v1's three
// GET handlers send over the wire (packages/core/src/store/{notes,events,overrides}.ts), the same
// choice useSeries.ts makes for SeriesPoint and for the same reason: importing the real types would
// mean importing the module that declares them, which is the barrel above.
export interface StoredNote {
  id: string
  localDate: string
  body: string
  updatedAtMs: number
}

export interface StoredEvent {
  id: string
  kind: string
  startedAtMs: number
  startedAtOffsetMinutes: number
  endedAtMs: number | null
  endedAtOffsetMinutes: number | null
  value: number | null
  note: string | null
  // The local day localDateOf(startedAtMs, startedAtOffsetMinutes) resolves to, computed once by
  // apps/server/src/routes/v1/annotations.ts (it already needs the answer to decide whether this
  // row belongs in the requested range) and handed back on the wire rather than recomputed here:
  // that arithmetic is DST sensitive and lives in packages/core/src/derive/localDay.ts, which has
  // no browser safe subpath the way ./target-key and ./metrics do. dayAnnotations.ts is the one
  // place this field is read.
  localDate: string
}

export interface StoredOverride {
  id: string
  scope: OverrideScope
  targetKey: string
  action: OverrideAction
  correctedValue: number | null
  reason: string
}

export interface AnnotationRange {
  from: string
  to: string
}

/**
 * The range a saved override actually touched, or null when it touched none.
 *
 * Null is not an error case: apps/server/src/routes/v1/annotations.ts's applyOverride returns it
 * when the target names a sample or a session no backfill has reached yet, which the store marks
 * nothing for. There is no local day to report and nothing derived is stale, so this is the type
 * being honest about a real response shape rather than the narrower `{ from, to }` the brief's own
 * sketch used, which cannot represent that answer at all.
 */
export type AffectedRange = AnnotationRange | null

export interface OverrideWriteResult {
  id: string
  affected: AffectedRange
  applied: boolean
}

export interface WriteOverrideInput {
  scope: OverrideScope
  targetKey: string
  action: OverrideAction
  correctedValue?: number
  reason: string
}

export interface RemoveOverrideInput {
  overrideId: string
}

export interface WriteNoteInput {
  localDate: string
  body: string
}

export interface WriteEventInput {
  kind: string
  startedAtMs: number
  startedAtOffsetMinutes?: number
  endedAtMs?: number
  endedAtOffsetMinutes?: number
  value?: number
  note?: string
}

export interface RemoveEventInput {
  eventId: string
}

export interface RemoveNoteInput {
  localDate: string
}

/** Every write here answers at least its own id; the override writes answer more, above. */
export interface IdResult {
  id: string
}

export function notesPath(personId: string, range: AnnotationRange): string {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  return `/api/v1/p/${personId}/notes?${params.toString()}`
}

export function eventsPath(personId: string, range: AnnotationRange): string {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  return `/api/v1/p/${personId}/events?${params.toString()}`
}

// No from/to: GET /overrides takes no range at all (annotations.ts's own comment says why, the
// management list this feeds wants every correction for the person regardless), so sending one
// would ask a question the route already refuses to answer and the query key below carries none
// either, which is what lets every range this hook is ever called with share one cache entry for
// this resource rather than fetching the same full list once per range.
export function overridesPath(personId: string): string {
  return `/api/v1/p/${personId}/overrides`
}

/**
 * Every event except a harvested Google recovery score.
 *
 * `admin.ts harvest-recovery` stores one event per day, carrying the herstelscore read off Google's
 * own app by hand - the only way to get it at all, since no API exposes it (not v4, not Health
 * Connect, not the companion). They exist so probe-recovery-calibration.mjs can fit this app's
 * recovery index against Google's, and they are instrumentation about the index, not something a
 * person recorded about their day.
 *
 * Reading them as ordinary events made a household's twenty harvested days read as twenty flagged
 * days on the Dashboard, put a marker on every one of them on every chart, and filled the Notes
 * page with rows nobody wrote. All three are surfaces that mean "here is what you said about these
 * days", and the answer they were giving was "you said the calibration ran".
 *
 * Filtered here rather than in each of the three, because three filters are three chances for one
 * of them to drift, and this hook is the single read all of them go through. Not filtered on the
 * server, which would take the rows out of the export as well: the archive should keep them, and
 * `harvest-recovery` itself reads them back to decide what to replace.
 *
 * The correction path does not go through the UI and so loses nothing by this: re-running
 * `harvest-recovery` replaces a date's score rather than duplicating it (admin.ts says so in as
 * many words), which is what makes hiding the rows safe rather than a trap.
 */
/*
 * `items` defensively, not `data.items`, and dashboard-cards.test.tsx is what insisted: a `select`
 * that throws is an ERRORED query to react-query, not a query with odd data. Every reader here
 * already writes `data?.items ?? []` because a response can arrive without the field, and a bare
 * `data.items.filter` turned that tolerated case into "This did not load." on the flagged days
 * card - a filter added to hide three rows, breaking the card it was added to fix.
 */
export const withoutHarvest = (data: { items?: StoredEvent[] }): { items: StoredEvent[] } =>
  ({ items: (data?.items ?? []).filter((event) => event.kind !== RECOVERY_HARVEST_EVENT_KIND) })

/**
 * The three list reads a panel or a management page needs for one range: notes and events scoped
 * to it, and every override regardless of it. personId comes from the session, never from a
 * parameter, the same guarantee useSeries makes and for the same reason: an account owns exactly
 * one person, and taking it here would let a caller ask for someone else's path.
 */
export function useAnnotations(range: AnnotationRange): {
  notes: UseQueryResult<{ items: StoredNote[] }>
  events: UseQueryResult<{ items: StoredEvent[] }>
  overrides: UseQueryResult<{ items: StoredOverride[] }>
} {
  const session = useSession()
  const personId = session.data?.personId
  const enabled = personId !== undefined

  const notes = useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'notes', { from: range.from, to: range.to }),
    enabled,
    queryFn: () => apiGet<{ items: StoredNote[] }>(notesPath(personId!, range)),
  })

  const events = useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'events', { from: range.from, to: range.to }),
    enabled,
    queryFn: () => apiGet<{ items: StoredEvent[] }>(eventsPath(personId!, range)),
    select: withoutHarvest,
  })

  const overrides = useQuery({
    // No range in the key, matching overridesPath: two callers asking for different ranges are
    // asking for the same list, and keying it by range would cache the identical response twice.
    queryKey: queryKeys.resource(personId ?? '', 'overrides'),
    enabled,
    queryFn: () => apiGet<{ items: StoredOverride[] }>(overridesPath(personId!)),
  })

  return { notes, events, overrides }
}

/**
 * True when a cached query belongs to this person and is keyed by a from/to range that overlaps
 * `affected`. This is deliberately resource agnostic: queryKeys.resource gives every ranged read
 * in this app (series, baseline, nights, and the notes/events reads above) the same key shape, a
 * `person`/id/resource/sorted-params tuple, and an override's correction can change what any of
 * them shows for that day. Naming each resource here would mean this file has to be edited every
 * time a future page adds another ranged read of the same person's data; reading the shape instead
 * means it does not.
 */
function overlapsAffected(queryKey: readonly unknown[], personId: string, affected: AnnotationRange): boolean {
  if (queryKey[0] !== 'person' || queryKey[1] !== personId) return false
  const params = queryKey[3]
  if (!Array.isArray(params)) return false
  let from: unknown
  let to: unknown
  for (const entry of params) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    if (entry[0] === 'from') from = entry[1]
    else if (entry[0] === 'to') to = entry[1]
  }
  if (typeof from !== 'string' || typeof to !== 'string') return false
  return from <= affected.to && to >= affected.from
}

/**
 * The point of this task: applied decides whether the *derived* caches are invalidated at all.
 * This is deliberately narrower than "everything a write touched": the raw row list (the
 * 'overrides' resource) is handled separately, unconditionally, at each call site, since that list
 * changes the moment the store commits and does not wait on the drain the way a derived number does.
 *
 * `affected` null means the override named a sample or a session no backfill has reached, so no
 * cached range anywhere can be showing a stale number for it: there is nothing to invalidate.
 * `applied` false means the write was saved but the drain did not reach it before responding, so
 * every cached range still shows the correct, unchanged numbers; invalidating here would refetch
 * and redraw exactly what is already on screen while the panel tells the reader the correction has
 * not landed yet, which is the contradiction this gate exists to prevent. Only `applied` true with
 * a real range means a cached query can be showing a number this write just changed underneath it.
 */
function invalidateAffected(queryClient: QueryClient, personId: string, result: OverrideWriteResult): void {
  if (result.affected === null || !result.applied) return
  const affected = result.affected
  void queryClient.invalidateQueries({
    predicate: (query) => overlapsAffected(query.queryKey, personId, affected),
  })
}

/** notes and events carry no drain and no applied field: a write to either takes effect the
 * instant it commits, so unlike an override write there is no gate to honour before invalidating
 * the resource that just changed for this person. Overrides use this too, unconditionally, for
 * the 'overrides' resource itself: see the comment on its call site in useWriteOverride for why
 * that one is not gated on applied the way invalidateAffected's date ranged invalidation is. */
function invalidateResource(queryClient: QueryClient, personId: string, resource: string): void {
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === 'person' && query.queryKey[1] === personId && query.queryKey[2] === resource,
  })
}

/** Throws rather than requesting a path naming an undefined person: unlike a read's `enabled`
 * guard, a mutation has no render cycle to withhold itself from, so the guard has to live in the
 * function a caller can only invoke by hand, after the session has had a chance to resolve.
 * Exported for useSourceNames.ts's own mutations, which need exactly the same guard. */
export function requirePersonId(personId: string | undefined): string {
  if (personId === undefined) throw new ApiError('unauthorized', null, 'no signed in person')
  return personId
}

export function useWriteOverride(): UseMutationResult<OverrideWriteResult, ApiError, WriteOverrideInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: WriteOverrideInput) => {
      const id = requirePersonId(personId)
      return apiSend<OverrideWriteResult>('POST', `/api/v1/p/${id}/overrides`, input)
    },
    // TanStack Query v5 hands onSuccess (data, variables, context); `input` here is the second
    // argument, the mutate() call's own WriteOverrideInput, which is where the scope this write
    // targeted actually lives - the response (`result`) never carries it back.
    onSuccess: (result, input) => {
      if (personId === undefined) return
      // Unconditional, unlike invalidateAffected below: the row is written to the store before
      // applyOverride ever runs (annotations.ts commits the write, then drains), so the override
      // exists whether or not the drain caught up. The overrides resource key carries no from/to
      // (overridesPath sends none, since GET /overrides ignores range), so overlapsAffected can
      // never match it; without this line the management list would never learn a write happened,
      // applied true or false alike.
      invalidateResource(queryClient, personId, 'overrides')
      invalidateAffected(queryClient, personId, result)
      // A session-scope write is invisible to invalidateAffected above, and not by accident:
      // overlapsAffected matches a cached query by finding a string `from` and a string `to` in its
      // key params, and neither useWorkoutSession ({ sessionId }) nor useIntradayWindow
      // ({ metric, startMs, endMs, source }) carries either. Both would age out on their own
      // staleTime while the range-keyed activity list struck the session through at once, so the
      // page a reader just excluded a session from would keep saying excluded: false for up to a
      // minute. Invalidating the two resources by name is the narrower of the two fixes M8a's own
      // comments named, and it is narrower than teaching overlapsAffected a sessionId: a millisecond
      // window is not a date range, and pretending it is would make that helper answer a question
      // it does not actually know how to answer.
      if (input.scope === 'session') {
        invalidateResource(queryClient, personId, 'session')
        invalidateResource(queryClient, personId, 'intraday-window')
      }
    },
  })
}

export function useRemoveOverride(): UseMutationResult<OverrideWriteResult, ApiError, RemoveOverrideInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: RemoveOverrideInput) => {
      const id = requirePersonId(personId)
      return apiSend<OverrideWriteResult>('DELETE', `/api/v1/p/${id}/overrides/${input.overrideId}`)
    },
    onSuccess: (result) => {
      if (personId === undefined) return
      // Same reasoning as useWriteOverride's own call: the row is gone from the store before
      // applyOverride runs, regardless of what the drain then does, so the list has to learn about
      // a removal unconditionally too.
      invalidateResource(queryClient, personId, 'overrides')
      invalidateAffected(queryClient, personId, result)
      // Unlike useWriteOverride, RemoveOverrideInput carries only an overrideId - the scope the
      // removed row was written at is not something this mutation's input or its
      // OverrideWriteResult response tells us (the response is { id, affected, applied }, the same
      // shape a write returns, and affected/applied both describe the derived rollup rather than
      // naming a scope). There is no way to tell "this removal was a session-scope override" from
      // "this removal was a sample or day_metric override" from here, so this invalidates both
      // resources on every removal rather than only on the ones that need it. The cost is one extra
      // no-op refetch on a session or intraday-window query that was never affected, which is cheap
      // next to leaving a reader who just un-excluded a session staring at a stale excluded: true.
      invalidateResource(queryClient, personId, 'session')
      invalidateResource(queryClient, personId, 'intraday-window')
    },
  })
}

export function useWriteNote(): UseMutationResult<IdResult, ApiError, WriteNoteInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: WriteNoteInput) => {
      const id = requirePersonId(personId)
      return apiSend<IdResult>('PUT', `/api/v1/p/${id}/notes/${input.localDate}`, { body: input.body })
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateResource(queryClient, personId, 'notes')
    },
  })
}

export function useRemoveNote(): UseMutationResult<IdResult, ApiError, RemoveNoteInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: RemoveNoteInput) => {
      const id = requirePersonId(personId)
      return apiSend<IdResult>('DELETE', `/api/v1/p/${id}/notes/${input.localDate}`)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateResource(queryClient, personId, 'notes')
    },
  })
}

export function useWriteEvent(): UseMutationResult<IdResult, ApiError, WriteEventInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: WriteEventInput) => {
      const id = requirePersonId(personId)
      return apiSend<IdResult>('POST', `/api/v1/p/${id}/events`, input)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateResource(queryClient, personId, 'events')
    },
  })
}

export function useRemoveEvent(): UseMutationResult<IdResult, ApiError, RemoveEventInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: RemoveEventInput) => {
      const id = requirePersonId(personId)
      return apiSend<IdResult>('DELETE', `/api/v1/p/${id}/events/${input.eventId}`)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateResource(queryClient, personId, 'events')
    },
  })
}
