import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { GlanceLog } from './useGlance.js'
import { apiGet, apiSend, ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { requirePersonId } from './useAnnotations.js'

/** What a tap on a chip answers: enough to show the reader what just landed and, for undo, which
 *  row to remove. Narrower than the route's own StoredEvent (useAnnotations.ts) - the caffeine
 *  button has no use for endedAtMs, value or note, all null on a fresh tap regardless. */
export interface LoggedEvent {
  id: string
  kind: string
  startedAtMs: number
  localDate: string
}

export interface QuickLogTapInput {
  kind: string
  day: string
}

export interface UndoTapInput {
  eventId: string
}

export interface SetMoodInput {
  day: string
  score: number | null
}

export interface SaveNoteInput {
  day: string
  body: string
}

/**
 * The five resources a quick-log write can change. `'glance'` is here because the dashboard's own
 * `log` rides on it (M9c); `'notes'` and `'events'` because the Notes page lists both and a tap or
 * a mood is one of each; `'quick-log-day'` and `'quick-log-presets'` are this file's own reads.
 * Named by value rather than derived from the query keys below, the same choice useAnnotations.ts
 * makes for its own invalidateResource: five call sites naming a resource each would be five
 * chances for one to drift, so every mutation here calls the one function instead.
 */
const LOG_RESOURCES = new Set(['glance', 'quick-log-day', 'quick-log-presets', 'notes', 'events'])

/** Invalidates every cached read a quick-log write can change, for this person alone. Its own
 *  function rather than useAnnotations.ts's private invalidateResource, which matches one resource
 *  at a time: every mutation below touches several at once, and five separate invalidateQueries
 *  calls would walk the whole cache five times for what one predicate answers in one pass. */
export function invalidateLog(queryClient: QueryClient, personId: string): void {
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === 'person' && query.queryKey[1] === personId
      && LOG_RESOURCES.has(String(query.queryKey[2])),
  })
}

/** `['person', id, 'quick-log-day', localDate]` - its own key rather than `queryKeys.resource`'s
 *  params form, since a day is the one thing every reader of this route asks by, never a filter
 *  atop it. */
export function dayLogKey(personId: string, localDate: string): readonly unknown[] {
  return [...queryKeys.resource(personId, 'quick-log-day'), localDate]
}

/**
 * The day's own log: its presets, the mood set for it, how many of each preset were tapped, and
 * its note. `initial` seeds the cache when the dashboard already has this day's answer as part of
 * its own glance (`Glance.log`) - the same day the glance panel is about to show, so asking again
 * would be a second request for data already on screen.
 */
export function useDayLog(localDate: string, initial?: GlanceLog): UseQueryResult<GlanceLog> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: dayLogKey(personId ?? '', localDate),
    enabled: personId !== undefined,
    queryFn: () => apiGet<GlanceLog>(`/api/v1/p/${personId!}/quick-log/day/${localDate}`),
    ...(initial === undefined ? {} : { initialData: initial }),
  })
}

/** A tap on a chip: files one event under `day`, timed by the route itself (quickLogInstant), not
 *  by anything this hook sends. */
export function useQuickLogTap(): UseMutationResult<LoggedEvent, ApiError, QuickLogTapInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: QuickLogTapInput) => {
      const id = requirePersonId(personId)
      return apiSend<LoggedEvent>('POST', `/api/v1/p/${id}/quick-log`, input)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateLog(queryClient, personId)
    },
  })
}

/** Undoes a tap: the same DELETE /events/:id useAnnotations.ts's useRemoveEvent sends, its own
 *  copy here because a chip's undo invalidates the log resources above rather than only 'events'. */
export function useUndoTap(): UseMutationResult<void, ApiError, UndoTapInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UndoTapInput) => {
      const id = requirePersonId(personId)
      return apiSend<void>('DELETE', `/api/v1/p/${id}/events/${input.eventId}`)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateLog(queryClient, personId)
    },
  })
}

/** Sets or clears the day's mood: PUT with a score, or DELETE when the reader clears it back to
 *  no answer. `null` is a real instruction here, the same way it is on Profile's birthDate. */
export function useSetMood(): UseMutationResult<void, ApiError, SetMoodInput> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SetMoodInput) => {
      const id = requirePersonId(personId)
      return input.score === null
        ? apiSend<void>('DELETE', `/api/v1/p/${id}/moods/${input.day}`)
        : apiSend<void>('PUT', `/api/v1/p/${id}/moods/${input.day}`, { score: input.score })
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateLog(queryClient, personId)
    },
  })
}

/** Saves the day's note: PUT with a body, or DELETE when the reader clears it to nothing (the
 *  same `body.trim() === ''` convention AnnotatePanel's own note action does not need, since that
 *  one always requires a non-empty body to submit at all).
 *
 *  The day's cached log takes the new note as the save starts, not when the refetch lands: the
 *  panel reads its note once, as it opens, and a save made while it closes (LogPanel's unmount
 *  save) leaves that cache stale with nothing observing it. Reopened before the refetch, the
 *  panel would show the old note, and an edit to it would save over the new one. A failed save
 *  puts the old note back, so the cache never claims what the server refused. */
export function useSaveNote(): UseMutationResult<void, ApiError, SaveNoteInput, { previous: string | null } | undefined> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  const setNote = (day: string, note: string | null) => {
    queryClient.setQueryData<GlanceLog>(dayLogKey(personId ?? '', day), (old) => old && { ...old, note })
  }
  return useMutation({
    mutationFn: (input: SaveNoteInput) => {
      const id = requirePersonId(personId)
      return input.body.trim() === ''
        ? apiSend<void>('DELETE', `/api/v1/p/${id}/notes/${input.day}`)
        : apiSend<void>('PUT', `/api/v1/p/${id}/notes/${input.day}`, { body: input.body })
    },
    onMutate: (input: SaveNoteInput) => {
      const cached = queryClient.getQueryData<GlanceLog>(dayLogKey(personId ?? '', input.day))
      if (cached === undefined) return undefined
      setNote(input.day, input.body.trim() === '' ? null : input.body)
      return { previous: cached.note }
    },
    onError: (_error, input, context) => {
      if (context !== undefined) setNote(input.day, context.previous)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateLog(queryClient, personId)
    },
  })
}

/** The person's own chips: their saved presets, offered to AnnotatePanel's event kind field as
 *  suggestions ahead of the seed set. */
export function usePresets(): UseQueryResult<{ kinds: string[] }> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'quick-log-presets'),
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ kinds: string[] }>(`/api/v1/p/${personId!}/quick-log/presets`),
  })
}

/** Replaces the person's saved chips outright - the route's own PUT semantics, not a merge. */
export function useSavePresets(): UseMutationResult<string[], ApiError, string[]> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (kinds: string[]) => {
      const id = requirePersonId(personId)
      return apiSend<{ kinds: string[] }>('PUT', `/api/v1/p/${id}/quick-log/presets`, { kinds })
        .then((result) => result.kinds)
    },
    onSuccess: () => {
      if (personId !== undefined) invalidateLog(queryClient, personId)
    },
  })
}
