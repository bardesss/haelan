import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { requirePersonId } from './useAnnotations.js'
import { useTranslation } from '../i18n/index.js'
import { formatShortDate } from '../format.js'
import type { Translate } from '../format.js'
import { localToday } from '../controls/range.js'

// Mirrors NamedSource in packages/core/src/store/sourceAliases.ts, which the route sends whole,
// the same choice useSyncStatus.ts makes for its own response type and for the same reason: the
// web app imports only @haelan/core's browser safe subpaths (./metrics, ./target-key), never its
// root export, because the root pulls better-sqlite3 and drizzle into the browser bundle.
export interface NamedSource {
  id: string
  externalId: string
  displayName: string
  alias: string | null
  /** The server's English name. Shown as sent unless `defaultName` lets it be said locally. */
  name: string
  kind: 'device' | 'app' | 'manual'
  createdAtMs: number
  /**
   * A known app's default, for sourceLabel. Optional on this side only: the demo's captured
   * responses predate the field until they are next regenerated, and absent reads as null.
   */
  defaultName?: DefaultName | null
}

/**
 * Mirrors DefaultName in packages/core/src/api/sourceNames.ts, for the reason NamedSource above is
 * a mirror. `key` is a string here rather than the core union: a server newer than this bundle may
 * send a key this catalogue has never heard of, and sourceLabel below falls back to the server's
 * English `name` for exactly that case rather than printing a raw catalogue path.
 */
export interface DefaultName {
  key: string
  /** The person's local date the source was first seen; only set to tell colliding defaults apart. */
  since: string | null
  /** A few characters of the id, only when `since` did not tell them apart either. */
  tag: string | null
}

/**
 * The name to print for a source, in the reader's language.
 *
 * The server resolves every name once, in English (NamedSource.name), because MCP tools and exports
 * have no reader's language to resolve into; this only re-says a known app's default in the
 * catalogue's words. The order is the server's own: an alias always wins, then the default, then
 * the name as sent - which for any other source already is the display name or the id. Taking
 * `alias` as optional lets the status panel's rows use this too: the server sends those a null
 * `defaultName` whenever an alias is set, so the alias arrives as `name` and is printed as sent.
 *
 * The date is short, in the reader's locale, and carries the year only when it is not the year of
 * `today`, the person's own local date: formatShortDate, the one helper the status panel's day
 * labels use too, so the two never disagree about the year - which they did around New Year east
 * of UTC while this read the browser's UTC clock (the review of PR 383).
 */
export function sourceLabel(
  source: { name: string, alias?: string | null, defaultName?: DefaultName | null },
  t: Translate,
  language: string,
  today: string,
): string {
  if (source.alias !== undefined && source.alias !== null) return source.alias
  const defaultName = source.defaultName
  if (defaultName === undefined || defaultName === null) return source.name
  const key = `sourceDefaults.${defaultName.key}`
  const base = t(key)
  // i18next hands back the key itself for a message it does not have.
  if (base === key) return source.name
  let label = base
  if (defaultName.since !== null) {
    label = t('sourceDefaults.since', { name: label, date: formatShortDate(defaultName.since, today, language) })
  }
  return defaultName.tag === null ? label : t('sourceDefaults.tagged', { name: label, tag: defaultName.tag })
}

/**
 * What the listing adds when it is asked for `?activity=1`, which only the settings card does.
 *
 * A separate type rather than optional fields on NamedSource: every other caller of this route
 * wants names and nothing else, and computing these measured 19-60ms against a real archive on a
 * route ControlRow hits from every page. Optional fields would put that cost back on the hot path
 * the moment somebody read them.
 */
export interface SourceActivityFields {
  /** Local date, null when this source has never produced a row. */
  lastReportedDate: string | null
  reportingDates: number
  medianGapDays: number | null
  /** 'unjudged' means too little history to have a cadence, not that it is fine. */
  status: 'reporting' | 'stale' | 'unjudged'
  /**
   * Whether the card lists it among the live sources. Computed by the server, not here: the
   * thresholds behind it belong in one place, and a second copy in the browser is how a rule
   * drifts. See packages/core/src/api/sourceCadence.ts, which both sides share.
   */
  reportingNow: boolean
  /**
   * A stale source whose routine metrics all kept arriving from other sources since it stopped -
   * a device the provider renamed, or whose data moved to another path. Still `stale` here,
   * because the id did stop. Nothing in this app reads it any more: the cards' warnings that
   * skipped such a source are gone, and the status panel, which now carries the warning, gets the
   * same verdict already applied by the server (composeStatus). Kept in the type because the
   * response still carries it. Computed by the server for
   * the same reason as `reportingNow`.
   */
  continuedElsewhere: boolean
  /**
   * Whether the person chose to show (true) or hide (false) this source in the status panel, or
   * null when it follows the default rule - shownByDefault in @haelan/core/status-panel, which
   * the source list imports rather than restating, for the reason `reportingNow` gives above.
   */
  panelChoice: boolean | null
}

export type NamedSourceWithActivity = NamedSource & SourceActivityFields

interface SourcesResponse { items: NamedSource[] }

/** Shared by the query, both mutations' invalidation and the tests, so all four agree. */
export function sourceNamesKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'sources')
}

export interface SourceNames {
  /**
   * The label for a source id, or the id itself when nothing better is known.
   *
   * The fallback is what makes this safe to call from anywhere: before the query answers, and
   * after it fails, every picker reads exactly as it did before this milestone rather than going
   * blank. Nothing on any page waits on names.
   */
  nameOf: (sourceId: string) => string
  sources: NamedSource[]
  isPending: boolean
  isError: boolean
  // Read only by ErrorState's own not_found branch (see its comment) - SourceNames.tsx has to
  // reach through this narrowed shape to hand ErrorState the underlying query's error.
  error: unknown
}

/**
 * The same listing with each source's activity, for the one surface that shows it.
 *
 * Its own key, a child of the plain one, so both are cached separately and a rename still
 * refreshes both: invalidateQueries matches by prefix unless told otherwise, and the two
 * mutations below pass the parent key.
 */
export function sourceActivityKey(personId: string): readonly unknown[] {
  return [...sourceNamesKey(personId), 'activity']
}

export function useSourceNames(): SourceNames {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: sourceNamesKey(personId ?? ''),
    // Same race useSyncStatus and useSeries guard: asking before the session resolves would cache
    // an answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<SourcesResponse>(`/api/v1/p/${personId!}/sources`),
  })

  const items = query.data?.items
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // The person's today, for the year rule in sourceLabel: read in their zone the way the status
  // control and the Settings card read it. A string, so the memo below only rebuilds when the
  // person's day actually changes.
  const today = localToday(session.data?.timezone)
  // Memoised on the query's own data reference, not rebuilt as a fresh object literal every
  // render: `nameOf` sits in IntradayHeartRate's `build` useCallback deps, which useChart keys its
  // init/dispose effect on, so a fresh function here (even one that reads the same names) disposed
  // and reinitialised that chart on every render regardless of whether anything it draws had
  // changed -- the exact defect chart-lifecycle.test.tsx exists to catch, on a chart that test
  // didn't reach until it grew a Day tab case.
  return useMemo(() => {
    const sources = items ?? []
    // Localised here, once per answer and per language, so every picker, legend and heading
    // that asks nameOf says a known app's default in the reader's words. `t` changes identity
    // only when the language does, so the memo holds for the reason the comment above gives.
    const byId = new Map(sources.map((s) => [s.id, sourceLabel(s, t, language, today)]))
    return {
      nameOf: (sourceId: string) => byId.get(sourceId) ?? sourceId,
      sources,
      isPending: query.isPending,
      isError: query.isError,
      error: query.error,
    }
  }, [items, t, language, today, query.isPending, query.isError, query.error])
}

/**
 * The listing with each source's activity, for the settings card and nothing else.
 *
 * A second hook rather than a flag on useSourceNames, because the two answer different questions
 * at different prices. useSourceNames backs ControlRow and IntradayHeartRate, so it runs on every
 * page, and the activity fields measured 19-60ms against a real archive - growing with the daily
 * row count. Keeping them behind their own hook and their own query key means no page pays for a
 * number only one card shows.
 */
export function useSourcesWithActivity(): {
  sources: NamedSourceWithActivity[]
  isPending: boolean
  isError: boolean
  error: unknown
} {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: sourceActivityKey(personId ?? ''),
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ items: NamedSourceWithActivity[] }>(
      `/api/v1/p/${personId!}/sources?activity=1`,
    ),
  })
  return {
    sources: query.data?.items ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  }
}

export function useRenameSource(): UseMutationResult<{ name: string }, ApiError, { sourceId: string, alias: string }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => {
      const id = requirePersonId(personId)
      return apiSend<{ name: string }>(
        'PUT', `/api/v1/p/${id}/sources/${input.sourceId}/alias`, { alias: input.alias },
      )
    },
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: sourceNamesKey(personId) })
    },
  })
}

export function useClearSourceName(): UseMutationResult<{ name: string }, ApiError, { sourceId: string }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => {
      const id = requirePersonId(personId)
      return apiSend<{ name: string }>(
        'DELETE', `/api/v1/p/${id}/sources/${input.sourceId}/alias`,
      )
    },
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: sourceNamesKey(personId) })
    },
  })
}
