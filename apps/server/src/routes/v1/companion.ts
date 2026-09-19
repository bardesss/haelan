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
 * with requestParams { source: COMPANION_SOURCE }, while Google fetches carry a filter.
 * This route groups those rows by data type and answers the newest window end and
 *  the newest fetch time per type, plus the oldest window start as the history start
 * the phone-history clamp names. A type with no row answers null, which is how the app tells a first
 * sync (send the full window) from a later one (send the delta with an overlap).
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

function normalizePlatform(value: string | string[] | undefined): void {
  if (value === undefined) return
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return
  const name = raw.trim().toLowerCase()
  if (name === '') throw new ConfigError('platform must not be empty')
  if (name === 'android' || name === 'health_connect' || name === 'health-connect' || name === 'healthconnect') return
  throw new ConfigError(`unknown platform '${raw}'`)
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
    const byType = new Map<string, { lastWindowEndMs: number, lastIngestAtMs: number }>()
    let historyStartMs: number | null = null
    for (const row of archive.listForSource(personId, COMPANION_SOURCE)) {
      const seen = byType.get(row.dataType)
      if (!seen || row.windowEndMs > seen.lastWindowEndMs) {
        byType.set(row.dataType, {
          lastWindowEndMs: row.windowEndMs,
          lastIngestAtMs: Math.max(seen?.lastIngestAtMs ?? 0, row.fetchedAtMs),
        })
      } else if (row.fetchedAtMs > seen.lastIngestAtMs) {
        seen.lastIngestAtMs = row.fetchedAtMs
      }
      if (historyStartMs === null || row.windowStartMs < historyStartMs) historyStartMs = row.windowStartMs
    }
    const items = companionIngestibleIds().map((dataTypeId) => {
      const cursor = byType.get(dataTypeId)
      return {
        dataTypeId,
        lastWindowEndMs: cursor?.lastWindowEndMs ?? null,
        lastIngestAtMs: cursor?.lastIngestAtMs ?? null,
      }
    })
    // Whether this person also walks the Google path. Cards clamp their range to the
    // history start only without one (step 4 of the phone-history clamp): a mixed person keeps the deep archive.
    const googleConnected = app.haelan.instance.credentials.isConnected(personId)
    return sendHashed(reply, request, { items, historyStartMs, googleConnected })
  })
}
