import type { FastifyInstance } from 'fastify'
import { COMPANION_SOURCE, ConfigError, DATA_TYPES, RawArchive, supports } from '@haelan/core'
import { sendHashed } from './shared.ts'

interface PersonParams { personId: string }

interface CursorsQuery {
  platform?: string | string[]
}

/**
 * Where the phone asks what it already sent, so it sends only what is new.
 *
 * The archive is the source of truth: every companion upload lands in raw_payloads
 * with requestParams { source: COMPANION_SOURCE, dataSource }, while Google fetches carry a
 * filter. This route groups those rows two ways.
 *
 * Health Connect has many writers into one type -- a phone and a watch both write steps -- and a
 * cursor shared across them is how a late arrival goes missing silently: a watch that syncs
 * Friday's steps in on Sunday finds the phone's own Sunday sync already moved the shared cursor
 * past Friday, and it is never asked for again. So the primary answer is one item per
 * (dataTypeId, dataSource), each carrying only that source's own cursor.
 *
 * Version 0.1.0 is already installed on a phone and reads one item per dataTypeId with a
 * lastWindowEndMs, via a regex, not a JSON parser (SyncCursors.parseCursorEnds). That shape is
 * kept alongside the new one, but its lastWindowEndMs is now the MINIMUM across the type's
 * sources rather than the maximum a single shared cursor used to answer. A maximum is the bug:
 * it is exactly what let one source's progress hide another's. A minimum is the safe direction
 * for a reader with no source of its own -- it asks for a little more than a fully upgraded
 * phone would need, and the archive dedups the repeat rather than losing anything.
 *
 * A type with no row answers null, which is how the app tells a first sync (send the full
 * window) from a later one (send the delta with an overlap).
 *
 * The list is the ingest contract, not the catalogue: the same predicate ingest.ts
 * refuses with, so the app never gets a cursor for a type the instance would refuse.
 */
export function companionIngestibleIds(): string[] {
  return DATA_TYPES.filter((t) =>
    supports(t, 'list') && !t.mappingDeferred
    && (t.target === 'samples' || t.target === 'sessions')
    && (t.alsoTargets?.length ?? 0) === 0,
  ).map((t) => t.id).sort()
}

/**
 * How long a source may sit silent before it stops holding a type's minimum back.
 *
 * The minimum across a type's sources fixed a late writer going missing, but nothing before this
 * aged a source back out of it: a replaced phone, a retired watch, or one hand typed MANUAL entry
 * keeps its cursor frozen at the day it stopped, and since the read start is the minimum across
 * every source, that dead one pins the whole type's window open for good -- it grows by a day a
 * day, and ingest.ts re-marks the whole re-read span dirty on every sync it does not need.
 *
 * The two ways to get this wrong cost differently. Too short and a source that is merely
 * intermittent -- a watch worn a couple of times a week -- ages out between wearings, and its next
 * late reading goes missing again: the exact loss the (type, source) minimum exists to prevent.
 * Too long only leaves the window wider for longer before a truly dead source is finally dropped.
 * Losing data is worse than a wide window, so this errs long: the app syncs roughly twice a day,
 * so a silent source has already missed dozens of chances by the time two weeks pass, which is
 * comfortably past the worst case for a watch worn twice a week (under ten days idle) and still
 * short enough that a genuinely dead source does not pin the window open indefinitely.
 */
export const STALE_SOURCE_MS = 14 * 24 * 60 * 60 * 1000

function normalizePlatform(value: string | string[] | undefined): void {
  if (value === undefined) return
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return
  const name = raw.trim().toLowerCase()
  if (name === '') throw new ConfigError('platform must not be empty')
  if (name === 'android' || name === 'health_connect' || name === 'health-connect' || name === 'healthconnect') return
  throw new ConfigError(`unknown platform '${raw}'`)
}

/**
 * The source identity ingest.ts resolves and archives beside `source` and `dataType`
 * (requestParams.dataSource). Every row this route reads has already passed listForSource's
 * `json_valid` guard, so parsing here cannot throw; a row archived before this field existed, or
 * one seeded directly by a test, answers 'unknown' -- one merged bucket for history a phone
 * already re-reads today, not a crash.
 */
function sourceIdentityOf(requestParams: string): string {
  const parsed = JSON.parse(requestParams) as { dataSource?: unknown }
  return typeof parsed.dataSource === 'string' ? parsed.dataSource : 'unknown'
}

export function registerCompanionRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: CursorsQuery }>('/p/:personId/companion/cursors', async (request, reply) => {
    normalizePlatform(request.query.platform)
    const personId = request.params.personId
    // Through RawArchive rather than SQL of our own: the archive owns the shape of
    // requestParams, and listForSource applies the `source: COMPANION_SOURCE` predicate in
    // SQL, so this walks only the phone's own rows. Narrowing here instead meant
    // JSON.parsing every row the person had ever archived, once an hour per open
    // dashboard, to answer null on an instance that has never seen the app.
    const archive = new RawArchive(app.haelan.instance.db)
    const ingestibleIds = companionIngestibleIds()
    const ingestible = new Set(ingestibleIds)

    // Keyed on the pair, so a source that syncs in late keeps its own progress instead of
    // sharing one a busier source already moved past it. Each entry is that one source's own
    // newest window end -- the same "latest wins" a single shared cursor always did, just no
    // longer shared across writers.
    const bySource = new Map<string, {
      dataTypeId: string
      dataSource: string
      lastWindowEndMs: number
      lastIngestAtMs: number
    }>()
    let historyStartMs: number | null = null

    for (const row of archive.listForSource(personId, COMPANION_SOURCE)) {
      const dataSource = sourceIdentityOf(row.requestParams)
      const sourceKey = `${row.dataType}:${dataSource}`
      const perSource = bySource.get(sourceKey)
      if (perSource) {
        if (row.windowEndMs > perSource.lastWindowEndMs) perSource.lastWindowEndMs = row.windowEndMs
        if (row.fetchedAtMs > perSource.lastIngestAtMs) perSource.lastIngestAtMs = row.fetchedAtMs
      } else {
        bySource.set(sourceKey, {
          dataTypeId: row.dataType, dataSource,
          lastWindowEndMs: row.windowEndMs, lastIngestAtMs: row.fetchedAtMs,
        })
      }

      if (historyStartMs === null || row.windowStartMs < historyStartMs) historyStartMs = row.windowStartMs
    }

    // Keyed on the type alone, for the shape 0.1.0 still reads: the MINIMUM, across the type's
    // sources, of each source's own newest window end -- see the module comment for why that is
    // the safe direction and the maximum was the bug. Derived from bySource rather than from the
    // raw rows directly: "minimum across sources" and "minimum across every row" only agree when
    // each source has uploaded exactly once, and a source re-synced twice must not pull the
    // legacy cursor back to its own first upload once its second one has landed.
    const nowMs = app.haelan.now()
    const byType = new Map<string, { minWindowEndMs: number, lastIngestAtMs: number }>()
    for (const cursor of bySource.values()) {
      // Aged out: this source stays in bySource and perSourceItems below unchanged, so a phone
      // that resumes writing under this identity just picks its progress back up. It only stops
      // being counted toward the type's minimum -- see STALE_SOURCE_MS for the threshold.
      if (nowMs - cursor.lastIngestAtMs > STALE_SOURCE_MS) continue
      const perType = byType.get(cursor.dataTypeId)
      if (perType) {
        if (cursor.lastWindowEndMs < perType.minWindowEndMs) perType.minWindowEndMs = cursor.lastWindowEndMs
        if (cursor.lastIngestAtMs > perType.lastIngestAtMs) perType.lastIngestAtMs = cursor.lastIngestAtMs
      } else {
        byType.set(cursor.dataTypeId, { minWindowEndMs: cursor.lastWindowEndMs, lastIngestAtMs: cursor.lastIngestAtMs })
      }
    }

    // Field order matters here and nowhere else in this file: SyncCursors.parseCursorEnds on an
    // un-updated phone finds `"dataTypeId":"...","lastWindowEndMs":...` with a regex, not a JSON
    // parser, so `dataTypeId` has to stay the field immediately before `lastWindowEndMs`.
    const legacyItems = ingestibleIds.map((dataTypeId) => {
      const cursor = byType.get(dataTypeId)
      return {
        dataTypeId,
        lastWindowEndMs: cursor?.minWindowEndMs ?? null,
        lastIngestAtMs: cursor?.lastIngestAtMs ?? null,
      }
    })
    // `dataSource` sits between `dataTypeId` and `lastWindowEndMs` on purpose, so this item's own
    // pair can never satisfy the old phone's regex and be mistaken for the legacy cursor above.
    const perSourceItems = [...bySource.values()]
      .filter((cursor) => ingestible.has(cursor.dataTypeId))
      .map((cursor) => ({
        dataTypeId: cursor.dataTypeId,
        dataSource: cursor.dataSource,
        lastWindowEndMs: cursor.lastWindowEndMs,
        lastIngestAtMs: cursor.lastIngestAtMs,
      }))

    // Whether this person also walks the Google path. Cards clamp their range to the
    // history start only without one (step 4 of the phone-history clamp): a mixed person keeps the deep archive.
    const googleConnected = app.haelan.instance.credentials.isConnected(personId)
    return sendHashed(reply, request, {
      items: [...legacyItems, ...perSourceItems],
      historyStartMs,
      googleConnected,
    })
  })
}
