import { parseDayMetricTarget, parseSampleTarget, parseSessionTarget } from '@haelan/core/target-key'
import { ApiError } from '../api/apiError.js'
import { DEMO_CLOCK_MS } from './instant.js'

// Mirrors OverrideAction in apps/web/src/data/useAnnotations.ts, mirrored there by value for the
// same reason this is: the enum has no browser safe subpath of its own.
type OverrideAction = 'exclude' | 'correct'

interface OverlayNote { id: string, localDate: string, body: string, updatedAtMs: number }

interface OverlayEvent {
  id: string
  kind: string
  startedAtMs: number
  startedAtOffsetMinutes: number
  endedAtMs: number | null
  endedAtOffsetMinutes: number | null
  value: number | null
  note: string | null
  localDate: string
}

interface OverlayOverride {
  id: string
  scope: string
  targetKey: string
  action: OverrideAction
  correctedValue: number | null
  reason: string
}

interface AffectedRange { from: string, to: string }

/**
 * Every write a demo visitor has made this session, kept in memory rather than in the fixtures:
 * the captured files are read only, so a write has nowhere else to live. Nothing here persists
 * across a reload, which is the same thing a real instance's writes are not - a demo visitor
 * cannot corrupt the recording, and the next visitor (or this one, on refresh) starts from it
 * clean.
 *
 * Notes are keyed by `localDate` rather than by their own id: the route itself takes no id
 * (`PUT`/`DELETE /notes/:localDate`), the schema's own unique constraint is one note per person
 * per local day (useAnnotations.ts's own comment on `notesPath` says so), and a demo id would
 * have nothing to be looked up by. `deletedNoteDates` exists because a capture can already have a
 * note on a date this session then deletes - `notes` losing the entry is not enough on its own to
 * suppress a captured row on the same date.
 */
export interface Overlay {
  notes: Map<string, OverlayNote>
  deletedNoteDates: Set<string>
  events: Map<string, OverlayEvent>
  deletedEventIds: Set<string>
  overrides: Map<string, OverlayOverride>
  deletedOverrideIds: Set<string>
  // sourceId -> alias, or null once cleared. Cleared is its own state, not an absent key: a
  // capture can already carry an alias on a source this session clears, and only a stored null
  // can override that captured value back out at read time.
  aliases: Map<string, string | null>
  // sourceId -> the status panel choice this session wrote: true (show), false (hide), or null
  // once cleared back to "follow the default" - the same three-state shape SourceVisibilityStore
  // itself documents, and the same reason `aliases` above stores an explicit null rather than
  // deleting the key: a capture can already show a source under its own default, and only a
  // stored null can tell composeSources and composeStatusPanel "no override, answer the captured
  // default" apart from "never written at all", which behaves identically here but would not once
  // a future write path needed to tell a visitor had touched this source at all.
  panelChoices: Map<string, boolean | null>
  // sessionId -> the localDate its own captured detail read answered with, recorded by
  // composeSessionDetail on every read regardless of whether that session carries an override -
  // see affectedRangeFor's own comment for why a session-scope write needs this and has nowhere
  // else to get it from.
  sessionLocalDates: Map<string, string>
}

export function createOverlay(): Overlay {
  return {
    notes: new Map(),
    deletedNoteDates: new Set(),
    events: new Map(),
    deletedEventIds: new Set(),
    overrides: new Map(),
    deletedOverrideIds: new Set(),
    aliases: new Map(),
    panelChoices: new Map(),
    sessionLocalDates: new Map(),
  }
}

const NOTES_LIST = /^\/api\/v1\/p\/[^/]+\/notes$/
const NOTE_ITEM = /^\/api\/v1\/p\/[^/]+\/notes\/([^/]+)$/
const EVENTS_LIST = /^\/api\/v1\/p\/[^/]+\/events$/
const EVENT_ITEM = /^\/api\/v1\/p\/[^/]+\/events\/([^/]+)$/
const OVERRIDES_LIST = /^\/api\/v1\/p\/[^/]+\/overrides$/
const OVERRIDE_ITEM = /^\/api\/v1\/p\/[^/]+\/overrides\/([^/]+)$/
const SOURCES_LIST = /^\/api\/v1\/p\/[^/]+\/sources$/
const SOURCE_ALIAS = /^\/api\/v1\/p\/[^/]+\/sources\/([^/]+)\/alias$/
const SOURCE_PANEL = /^\/api\/v1\/p\/[^/]+\/sources\/([^/]+)\/panel$/
// Flat, with no personId segment: apps/server/src/routes/status.ts's own doc comment on
// /api/status says why - it answers for the caller's own person off the session, the same as
// /api/sync/status beside it, never off a path segment the way every /p/:personId route is.
const STATUS = /^\/api\/status$/
const SERIES = /^\/api\/v1\/p\/[^/]+\/series$/
const INTRADAY = /^\/api\/v1\/p\/[^/]+\/intraday(?:\/window)?$/
const SESSIONS_LIST = /^\/api\/v1\/p\/[^/]+\/sessions$/
const SESSION_ITEM = /^\/api\/v1\/p\/[^/]+\/sessions\/([^/]+)$/

function splitUrl(url: string): { path: string, params: URLSearchParams } {
  const [path = '', search = ''] = url.split('?')
  return { path, params: new URLSearchParams(search) }
}

/**
 * Composes overlay state over one captured response. Returns `body` itself, not a copy, whenever
 * nothing in the overlay touches the path asked for: an unrecognised path always does (the demo
 * answers plenty of reads this module has no opinion on), and a recognised one does too once its
 * own overlay state is empty, which keeps every read that nobody has written over exactly the
 * object the manifest produced.
 */
export function applyOverlay(url: string, body: unknown, overlay: Overlay): unknown {
  const { path, params } = splitUrl(url)
  if (NOTES_LIST.test(path)) return composeNotes(params, body, overlay)
  if (EVENTS_LIST.test(path)) return composeEvents(params, body, overlay)
  if (OVERRIDES_LIST.test(path)) return composeOverrides(body, overlay)
  if (SOURCES_LIST.test(path)) return composeSources(body, overlay)
  if (STATUS.test(path)) return composeStatusPanel(body, overlay)
  if (SERIES.test(path)) return composeSeries(body, overlay)
  if (INTRADAY.test(path)) return composeIntraday(params, body, overlay)
  if (SESSIONS_LIST.test(path)) return composeSessionsList(body, overlay)
  const sessionItem = path.match(SESSION_ITEM)
  if (sessionItem) return composeSessionDetail(sessionItem[1]!, body, overlay)
  return body
}

/**
 * Performs one write against the overlay and answers exactly what the real route would: the
 * contract table in this task's brief names every shape below. `client.ts` is the only caller,
 * routing every non-GET method here instead of at the manifest, which has never captured a write.
 */
export function writeThrough(method: string, url: string, payload: unknown, overlay: Overlay): unknown {
  const path = url.split('?')[0] ?? ''
  let match: RegExpMatchArray | null

  if (method === 'POST' && OVERRIDES_LIST.test(path)) return addOverride(payload, overlay)
  if (method === 'DELETE' && (match = path.match(OVERRIDE_ITEM))) return removeOverride(match[1]!, overlay)
  if (method === 'PUT' && (match = path.match(NOTE_ITEM))) return writeNote(match[1]!, payload, overlay)
  if (method === 'DELETE' && (match = path.match(NOTE_ITEM))) return removeNote(match[1]!, overlay)
  if (method === 'POST' && EVENTS_LIST.test(path)) return addEvent(payload, overlay)
  if (method === 'DELETE' && (match = path.match(EVENT_ITEM))) return removeEvent(match[1]!, overlay)
  if (method === 'PUT' && (match = path.match(SOURCE_ALIAS))) return renameSource(match[1]!, payload, overlay)
  if (method === 'DELETE' && (match = path.match(SOURCE_ALIAS))) return clearSourceAlias(match[1]!, overlay)
  if (method === 'PUT' && (match = path.match(SOURCE_PANEL))) return setPanelChoice(match[1]!, payload, overlay)
  if (method === 'DELETE' && (match = path.match(SOURCE_PANEL))) return clearPanelChoice(match[1]!, overlay)

  // The recorder only ever captured GETs, and every write this build knows how to answer is
  // matched above - reaching here means either a route the app has grown since this file was
  // written, or a demo bug sending the wrong method or path.
  throw new ApiError('not_found', 404, `the demo has no recorded response for ${method} ${url}`)
}

// ---- notes ----------------------------------------------------------------------------------

function writeNote(localDate: string, payload: unknown, overlay: Overlay): { id: string } {
  const body = payload as { body: string }
  // The id survives an edit to the same day: PUT is an upsert on (person, localDate) in the real
  // store too, so a note written twice is one row, not two.
  const id = overlay.notes.get(localDate)?.id ?? crypto.randomUUID()
  // DEMO_CLOCK_MS, not Date.now(): every captured row is stamped at the seed instant, and a demo
  // build freezes the browser's own clock to it (frozenClock.ts) - but a unit test never installs
  // that freeze, and importing the same constant this module's caller does is what keeps a note
  // written here on the same clock as everything else in the demo, tested or not.
  overlay.notes.set(localDate, { id, localDate, body: body.body, updatedAtMs: DEMO_CLOCK_MS })
  overlay.deletedNoteDates.delete(localDate)
  return { id }
}

function removeNote(localDate: string, overlay: Overlay): { id: string } {
  overlay.notes.delete(localDate)
  // Marked even when this date was never in `notes`: a captured fixture can already have a note
  // here, and only this set can suppress that captured row from a later read.
  overlay.deletedNoteDates.add(localDate)
  return { id: localDate }
}

function composeNotes(params: URLSearchParams, body: unknown, overlay: Overlay): unknown {
  if (overlay.notes.size === 0 && overlay.deletedNoteDates.size === 0) return body
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  // A captured date also in `notes` is dropped, not kept alongside it: PUT is an upsert on
  // (person, localDate) in the real store, one row per day, so a demo edit to an already
  // captured day has to replace that day's row rather than add a second one beside it. Latent
  // today because every captured notes body is empty (the household never wrote one), but it
  // becomes real the moment a future seed adds notes of its own.
  const captured = (body as { items: { localDate: string }[] }).items
    .filter((item) => !overlay.deletedNoteDates.has(item.localDate) && !overlay.notes.has(item.localDate))
  const written = [...overlay.notes.values()].filter((item) => item.localDate >= from && item.localDate <= to)
  return { items: [...captured, ...written] }
}

// ---- events -----------------------------------------------------------------------------------

// Mirrors packages/core/src/derive/localDay.ts's localDateOf, which has no browser safe subpath
// (useAnnotations.ts's own comment on StoredEvent.localDate names the same gap): a demo written
// event still has to answer which local day it falls on, the way the real route computes it
// before ever reaching the store, or the range filter below could not place it.
function localDateOf(utcMs: number, tzOffsetMinutes: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const shifted = new Date(utcMs + tzOffsetMinutes * 60_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

function addEvent(payload: unknown, overlay: Overlay): { id: string } {
  const body = payload as {
    kind: string
    startedAtMs: number
    startedAtOffsetMinutes?: number
    endedAtMs?: number
    endedAtOffsetMinutes?: number
    value?: number
    note?: string
  }
  const id = crypto.randomUUID()
  const startedAtOffsetMinutes = body.startedAtOffsetMinutes ?? 0
  overlay.events.set(id, {
    id,
    kind: body.kind,
    startedAtMs: body.startedAtMs,
    startedAtOffsetMinutes,
    endedAtMs: body.endedAtMs ?? null,
    endedAtOffsetMinutes: body.endedAtOffsetMinutes ?? null,
    value: body.value ?? null,
    note: body.note ?? null,
    localDate: localDateOf(body.startedAtMs, startedAtOffsetMinutes),
  })
  return { id }
}

function removeEvent(eventId: string, overlay: Overlay): { id: string } {
  overlay.events.delete(eventId)
  overlay.deletedEventIds.add(eventId)
  return { id: eventId }
}

function composeEvents(params: URLSearchParams, body: unknown, overlay: Overlay): unknown {
  if (overlay.events.size === 0 && overlay.deletedEventIds.size === 0) return body
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const captured = (body as { items: { id: string }[] }).items
    .filter((item) => !overlay.deletedEventIds.has(item.id))
  const written = [...overlay.events.values()].filter((item) => item.localDate >= from && item.localDate <= to)
  return { items: [...captured, ...written] }
}

// ---- overrides --------------------------------------------------------------------------------

/**
 * The range a `day_metric` or `session` write touches, or null when neither applies or the date
 * needed to answer isn't known yet.
 *
 * `day_metric` reads its date straight out of the target key. `session` cannot: the real route
 * resolves the session's own `localDate` from its store, but `WriteOverrideInput` (the payload a
 * demo write actually receives) carries only `{ scope, targetKey, action, reason,
 * correctedValue }` - no date - so this function has no captured row of its own to look one up in
 * either. `composeSessionDetail`'s own read path is what closes that gap: every `/sessions/:id`
 * read this session has made (unconditionally, whether or not that session carries an override)
 * leaves its `localDate` in `overlay.sessionLocalDates`, keyed by sessionId, and this function
 * reads it back by the same key `parseSessionTarget` pulls out of the write's own target key.
 * AnnotatePanel's one caller for `scope: 'session'` (WorkoutDetail.tsx) always mounts the page,
 * and so always makes that read, before a reader can ever reach the button that writes this
 * override - so in practice the id is always there by the time this runs. A session this overlay
 * has never read (in principle reachable if a future caller wrote this scope from somewhere that
 * never fetched the session itself) still answers null rather than guessing, the same as `sample`
 * always does below: `useWriteOverride`'s `onSuccess` invalidates the `session` and
 * `intraday-window` resources by name unconditionally for exactly this scope, precisely because it
 * cannot fully trust `affected` here either, so the workout page's own excluded flag still
 * refetches and redraws even on that null. What null no longer costs, now that the common case
 * answers a real range, is the `/sessions` LIST staying stale: `invalidateAffected` matches a
 * cached query by scanning its key for a string `from`/`to` overlapping this range, which
 * `invalidateResource(..., 'session')` above never reaches because the list's own resource name is
 * `'sessions'` (useSessions.ts), not `'session'` (useWorkoutSession.ts) - the exact mismatch a
 * demo visitor who excludes a workout and returns to Activity within `staleTime` used to see as a
 * row that forgot it was just excluded.
 *
 * `sample` has no equivalent read path to close the same way: nothing in this app reads one
 * intraday sample by itself the way `/sessions/:id` reads one session, so there is no captured
 * body this module could record an instant off before a `sample` write needs one.
 */
function affectedRangeFor(scope: string, targetKey: string, overlay: Overlay): AffectedRange | null {
  if (scope === 'day_metric') {
    try {
      const { localDate } = parseDayMetricTarget(targetKey)
      return { from: localDate, to: localDate }
    } catch {
      // Mirrors annotations.ts's own route: a malformed target throws before anything is written,
      // and the shared 400 it answers with is the right answer for a demo write too.
      throw new ApiError('config', 400, `malformed day_metric target key: ${targetKey}`)
    }
  }
  if (scope === 'session') {
    let sessionId: string
    try {
      sessionId = parseSessionTarget(targetKey)
    } catch {
      return null
    }
    const localDate = overlay.sessionLocalDates.get(sessionId)
    return localDate === undefined ? null : { from: localDate, to: localDate }
  }
  return null
}

function addOverride(payload: unknown, overlay: Overlay): { id: string, affected: AffectedRange | null, applied: boolean } {
  const body = payload as {
    scope: string, targetKey: string, action: OverrideAction, reason: string, correctedValue?: number
  }
  const affected = affectedRangeFor(body.scope, body.targetKey, overlay)
  const id = crypto.randomUUID()
  overlay.overrides.set(id, {
    id, scope: body.scope, targetKey: body.targetKey, action: body.action, reason: body.reason,
    correctedValue: body.correctedValue ?? null,
  })
  // Always true, unlike the real route: `applied` there answers whether a background drain
  // caught up with the write before the request returned, and the demo has no drain to wait on -
  // every write here is visible to the very next read, on the same tick that made it.
  return { id, affected, applied: true }
}

function removeOverride(overrideId: string, overlay: Overlay): { id: string, affected: AffectedRange | null, applied: boolean } {
  const existing = overlay.overrides.get(overrideId)
  overlay.overrides.delete(overrideId)
  overlay.deletedOverrideIds.add(overrideId)
  // Only an override this session itself wrote can answer a real range - see affectedRangeFor's
  // own comment for why an id this overlay never saw (a captured row, if the demo ever seeds one)
  // cannot. The list composition below still drops it either way.
  const affected = existing ? affectedRangeFor(existing.scope, existing.targetKey, overlay) : null
  return { id: overrideId, affected, applied: true }
}

function composeOverrides(body: unknown, overlay: Overlay): unknown {
  if (overlay.overrides.size === 0 && overlay.deletedOverrideIds.size === 0) return body
  const captured = (body as { items: { id: string }[] }).items
    .filter((item) => !overlay.deletedOverrideIds.has(item.id))
  return { items: [...captured, ...overlay.overrides.values()] }
}

/** Every `day_metric` exclusion this session has written, grouped by the metric it names. */
function dayMetricExclusions(overlay: Overlay): Map<string, Set<string>> {
  const byMetric = new Map<string, Set<string>>()
  for (const override of overlay.overrides.values()) {
    if (override.scope !== 'day_metric' || override.action !== 'exclude') continue
    // Skipped, not thrown, the same guard chartAnnotations.ts's overridesByMetric keeps: a
    // malformed row must not take a chart down. addOverride already refuses one at write time,
    // so reaching an unparsable key here would mean a version ahead of this one wrote it.
    let target
    try {
      target = parseDayMetricTarget(override.targetKey)
    } catch {
      continue
    }
    const dates = byMetric.get(target.metric) ?? new Set<string>()
    dates.add(target.localDate)
    byMetric.set(target.metric, dates)
  }
  return byMetric
}

/**
 * Deletes an excluded day's point out of whichever metric object it belongs to, wherever the
 * captured body nests it. `/series` answers `{ [metric]: { points } }` directly; this task's own
 * hand built fixtures nest that one level deeper. Walking the tree once, by matching the property
 * name against the metric rather than assuming a fixed depth, answers both without this module
 * having to pick one captured shape to trust over the other. A point's date is read as either
 * `localDate` (the real wire field, per apps/web/src/data/useSeries.ts's SeriesPoint) or `date`
 * (this task's own fixtures), for the same reason.
 */
function removeSeriesPoints(node: unknown, metric: string, dates: ReadonlySet<string>): void {
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const points = (value as { points?: unknown }).points
    if (key === metric && Array.isArray(points)) {
      const series = value as { points: Record<string, unknown>[] }
      series.points = series.points.filter((point) => {
        const date = point['localDate'] ?? point['date']
        return typeof date !== 'string' || !dates.has(date)
      })
    } else {
      removeSeriesPoints(value, metric, dates)
    }
  }
}

function composeSeries(body: unknown, overlay: Overlay): unknown {
  const excludedByMetric = dayMetricExclusions(overlay)
  if (excludedByMetric.size === 0) return body
  // Cloned rather than mutated in place: the caller may hold onto `body` (a test fixture reused
  // across cases, or a query cache entry a second read shares), and deriveDay's own reasoning
  // applies here too - a filter has to answer a new list, never edit the one it was handed.
  const clone = structuredClone(body)
  for (const [metric, dates] of excludedByMetric) removeSeriesPoints(clone, metric, dates)
  return clone
}

// ---- intraday -----------------------------------------------------------------------------------

interface SampleOverride { action: OverrideAction, correctedValue: number | null }

/** Every `sample` scoped override naming an instant of `metric`, keyed by source and instant. */
function sampleOverridesFor(overlay: Overlay, metric: string): Map<string, SampleOverride> {
  const map = new Map<string, SampleOverride>()
  for (const override of overlay.overrides.values()) {
    if (override.scope !== 'sample') continue
    let target
    try {
      target = parseSampleTarget(override.targetKey)
    } catch {
      continue
    }
    if (target.metric !== metric) continue
    map.set(`${target.source}:${target.utcMs}`, { action: override.action, correctedValue: override.correctedValue })
  }
  return map
}

/**
 * A sample correction rewrites the point's value; a sample exclusion marks it `excluded` rather
 * than dropping it, the same asymmetry `readIntraday`'s own comment keeps: a chart needs the
 * excluded point still present to anchor its marker on.
 *
 * Every aggregate the point carries takes the corrected reading, matching tier2.ts's own
 * `readWindow`: the person corrected one reading, not one of its three summaries.
 */
function composeIntraday(params: URLSearchParams, body: unknown, overlay: Overlay): unknown {
  const metric = params.get('metric')
  if (metric === null) return body
  const corrections = sampleOverridesFor(overlay, metric)
  if (corrections.size === 0) return body

  const clone = structuredClone(body) as { points: Record<string, unknown>[] }
  for (const point of clone.points) {
    const key = `${point['sourceId']}:${point['utcMs']}`
    const override = corrections.get(key)
    if (!override) continue
    if (override.action === 'exclude') {
      point['excluded'] = true
    } else if (override.correctedValue !== null) {
      point['min'] = override.correctedValue
      point['mean'] = override.correctedValue
      point['max'] = override.correctedValue
    }
  }
  return clone
}

// ---- sessions -----------------------------------------------------------------------------------

/**
 * A session-scope exclusion has to be visible on `/sessions/:id` and on the matching row in
 * `/sessions`, or excluding a workout looks like it did nothing: `useWriteOverride`'s `onSuccess`
 * invalidates the `session` and `intraday-window` resources by name for exactly this write
 * (useWorkoutSession.ts's own comment says why: its key carries a sessionId, not a from/to range,
 * so `overlapsAffected` can never match it), which means the page refetches and, without this,
 * redraws the identical captured row.
 *
 * This stays inside the fidelity limit rather than crossing it: `excluded` and `excludeReason`
 * are fields the capture already carries (packages/core/src/query/sessions.ts serialises the
 * reader's row unchanged), so this substitutes two recorded fields the same way `composeSources`
 * substitutes a name - it does not recompute anything a real instance derives from the exclusion,
 * the way a cardio load recompute would.
 *
 * Only ever one override, never a stack: `session` scope accepts only `exclude`
 * (`OverrideStore.validate` refuses `correct` here), so the way a demo visitor undoes one is by
 * removing the row, not by writing an opposing action - `removeOverride` already deletes it from
 * `overlay.overrides`, and an id with no entry here answers with whatever the capture says, which
 * is the correct un-excluded state to fall back to.
 */
function sessionOverrideFor(overlay: Overlay, sessionId: string): OverlayOverride | undefined {
  for (const override of overlay.overrides.values()) {
    if (override.scope !== 'session') continue
    let target: string
    try {
      target = parseSessionTarget(override.targetKey)
    } catch {
      continue
    }
    if (target === sessionId) return override
  }
  return undefined
}

function excludedFieldsFor(override: OverlayOverride): { excluded: boolean, excludeReason: string | null } {
  const excluded = override.action === 'exclude'
  return { excluded, excludeReason: excluded ? override.reason : null }
}

function composeSessionDetail(sessionId: string, body: unknown, overlay: Overlay): unknown {
  // Recorded on every read, whether or not this session carries an override (yet): see
  // affectedRangeFor's own comment for why a session-scope write has no date of its own to send,
  // and why this is where one has to come from instead.
  const localDate = (body as { localDate?: unknown }).localDate
  if (typeof localDate === 'string') overlay.sessionLocalDates.set(sessionId, localDate)

  const override = sessionOverrideFor(overlay, sessionId)
  if (!override) return body
  return { ...(body as Record<string, unknown>), ...excludedFieldsFor(override) }
}

function composeSessionsList(body: unknown, overlay: Overlay): unknown {
  const anySessionOverride = [...overlay.overrides.values()].some((o) => o.scope === 'session')
  if (!anySessionOverride) return body
  const typed = body as { items: Record<string, unknown>[] }
  const items = typed.items.map((item) => {
    const override = sessionOverrideFor(overlay, item['id'] as string)
    return override ? { ...item, ...excludedFieldsFor(override) } : item
  })
  return { ...typed, items }
}

// ---- source aliases -----------------------------------------------------------------------------

/**
 * Mirrors `nameFor` in packages/core/src/store/sourceAliases.ts, which has no browser safe
 * subpath (it lives in a module that imports drizzle-orm and the schema): alias, then the
 * provider's own name, then the id, so a demo composed source resolves its name the same way a
 * real one does.
 */
function nameFor(id: string, displayName: string, alias: string | null): string {
  if (alias !== null) return alias
  return displayName === '' ? id : displayName
}

function renameSource(sourceId: string, payload: unknown, overlay: Overlay): { name: string } {
  const body = payload as { alias: string }
  overlay.aliases.set(sourceId, body.alias)
  // Always the alias itself: nameFor above resolves to it whenever one is set, so there is
  // nothing about the captured row this answer needs to know.
  return { name: body.alias }
}

function clearSourceAlias(sourceId: string, overlay: Overlay): { name: string } {
  overlay.aliases.set(sourceId, null)
  // The real route echoes back the provider's own display name (or the id, once that is blank
  // too) once an alias is cleared - the value nameFor falls back to. writeThrough only ever sees
  // the sourceId a caller sent, never the captured source list, so it cannot look that fallback
  // up; nothing reads this field back (useClearSourceName's onSuccess only invalidates the
  // query), and the composed /sources read below still resolves the real provider name from the
  // captured row, so the id here is a placeholder nothing on screen ever shows.
  return { name: sourceId }
}

function composeSources(body: unknown, overlay: Overlay): unknown {
  if (overlay.aliases.size === 0 && overlay.panelChoices.size === 0) return body
  const items = (body as { items: Record<string, unknown>[] }).items.map((item) => {
    // The real wire field is `id` (useSourceNames.ts's NamedSource); read `sourceId` too, the
    // name this task's own fixture uses for the same row, for the reason removeSeriesPoints
    // above reads a point's date under either spelling: this module answers to how the write
    // side names the thing (`renameSource`'s `sourceId` parameter, taken straight off the URL)
    // without insisting the read side's capture spell it identically.
    const sourceId = (item['id'] ?? item['sourceId']) as string | undefined
    if (sourceId === undefined) return item
    let result = item
    if (overlay.aliases.has(sourceId)) {
      const alias = overlay.aliases.get(sourceId)!
      const displayName = (item['displayName'] as string | undefined) ?? ''
      result = { ...result, alias, name: nameFor(sourceId, displayName, alias) }
    }
    // The route's own field name (sources.ts's registerSourceRoutes) - a choice this session
    // wrote (true, false, or an explicit null once cleared) always wins over whatever the capture
    // answered, the same way an alias write above does.
    if (overlay.panelChoices.has(sourceId)) {
      result = { ...result, panelChoice: overlay.panelChoices.get(sourceId) ?? null }
    }
    return result
  })
  return { items }
}

// ---- status panel choices -----------------------------------------------------------------------

function setPanelChoice(sourceId: string, payload: unknown, overlay: Overlay): { visible: boolean } {
  const body = payload as { visible: boolean }
  overlay.panelChoices.set(sourceId, body.visible)
  return { visible: body.visible }
}

function clearPanelChoice(sourceId: string, overlay: Overlay): { visible: null } {
  // Stored as an explicit null, not deleted - see the Overlay interface's own comment on
  // `panelChoices` for why an absent key and a cleared one cannot be collapsed into each other.
  overlay.panelChoices.set(sourceId, null)
  return { visible: null }
}

interface OverlayStatusDevice { sourceId: string, choice: boolean | null, stale?: boolean, [key: string]: unknown }
interface OverlayStatusConnection { problem: string | null, devices: OverlayStatusDevice[], [key: string]: unknown }
interface OverlayStatusPanel {
  connections: OverlayStatusConnection[]
  hiddenDevices: number
  problems: number
  [key: string]: unknown
}

/**
 * Applies every panel-choice write this session has made to the captured `/api/status` read.
 *
 * Hiding a device the capture already shows is the direction this can answer in full: the device
 * is dropped from its connection's own list, `hiddenDevices` grows by one for it, and `problems`
 * is recomputed from what is left (composeStatus's own formula - a connection with a problem plus
 * every visible, stale device - recomputed rather than decremented ad hoc, so a later change to
 * that formula in packages/core cannot quietly drift the two apart).
 *
 * Showing a device the capture already counted as hidden cannot be answered the same way:
 * composeStatus's own doc comment says `hiddenDevices` is a count, never a list, so there is no
 * name or lastReportedDate recorded anywhere in this response for a device that was never in it to
 * begin with - the same fidelity limit `clearSourceAlias` above documents for a cleared alias
 * whose fallback name this overlay was never told either. A visitor who un-hides an
 * already-hidden device sees the choice recorded (a future capture that includes the device would
 * honour it), but the row itself does not appear and `hiddenDevices` does not fall, rather than
 * this module guessing whether the count it cannot itself verify still applies.
 *
 * Always recomposed from the untouched captured `body`, never from a previous call's own answer:
 * every device this function has not this time filtered out is exactly the device the capture
 * itself carried, so a choice reversed later (hide, then show again) needs nothing undone here -
 * the next read starts over from the same source of truth every other read does.
 */
function composeStatusPanel(body: unknown, overlay: Overlay): unknown {
  if (overlay.panelChoices.size === 0) return body
  const clone = structuredClone(body) as OverlayStatusPanel
  let hiddenDelta = 0
  for (const connection of clone.connections) {
    connection.devices = connection.devices.filter((device) => {
      const choice = overlay.panelChoices.get(device.sourceId)
      if (choice === undefined) return true
      device.choice = choice
      if (choice === false) { hiddenDelta += 1; return false }
      return true
    })
  }
  clone.hiddenDevices += hiddenDelta
  clone.problems = clone.connections.reduce((total, connection) => {
    const connectionProblem = connection.problem !== null ? 1 : 0
    const staleDevices = connection.devices.filter((device) => device.stale === true).length
    return total + connectionProblem + staleDevices
  }, 0)
  return clone
}
