import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily, samples, sessions, sessionSegments } from '../db/schema/index.ts'
import { dataTypeById } from '../api/catalogue.ts'
import { mapWindowSamples } from '../api/mapSamples.ts'
import { mapSessions } from '../api/mapSessions.ts'
import { mapRollups } from '../api/mapRollups.ts'
import { localDateOf } from '../derive/localDay.ts'
import type { ArchivedPayload, RawArchive } from '../store/rawArchive.ts'
import type { SourceRegistry } from '../store/sources.ts'

export interface ReplayInput {
  personId: string
  payloads: readonly ArchivedPayload[]
  archive: RawArchive
  sources: SourceRegistry
  nowMs: number
}

export interface ReplayCounts {
  samples: number
  sessions: number
  segments: number
  providerDaily: number
  /** Payloads no current mapper claims. Reported rather than thrown, see below. */
  unmappable: number
  /** Every local date a sample or a session landed on, which is what needs deriving after. */
  localDates: string[]
}

/**
 * Rebuilds one person's tier 2 from their archived payloads, through the mappers as they are
 * today rather than as they were when the payloads arrived.
 *
 * The caller owns the transaction and has already emptied the person's tier 2 and 3. Sources are
 * resolved fresh here rather than reused, which is the whole point of the milestone, an identity
 * the current describe() would no longer produce must not survive a rebuild.
 */
export function replayPerson(tx: DbOrTx, input: ReplayInput): ReplayCounts {
  const counts: ReplayCounts = {
    samples: 0, sessions: 0, segments: 0, providerDaily: 0, unmappable: 0, localDates: [],
  }
  const localDates = new Set<string>()
  const resolveSource = (dataSource: unknown): string =>
    input.sources.resolve(input.personId, dataSource, input.nowMs, tx)

  for (const group of groupIntoWindows(input.payloads)) {
    const t = dataTypeById(group.dataType)
    // A data type the catalogue no longer describes leaves payloads nobody can map. Counted and
    // reported rather than thrown, because one retired type must not cost a person the rebuild
    // of every other type they have. The bodies stay in tier 1 either way.
    if (t === undefined) { counts.unmappable += group.pages.length; continue }

    const pages = group.pages.map((p) => ({
      body: input.archive.getBody(input.personId, p.id),
      rawPayloadId: p.id,
    }))

    if (group.isRollup) {
      for (const page of pages) {
        const mapped = mapRollups({ dataType: t, body: page.body, personId: input.personId })
        for (const row of mapped.rows) {
          tx.insert(daily).values(row).onConflictDoUpdate({
            target: [daily.personId, daily.localDate, daily.metric, daily.agg, daily.source],
            set: {
              value: row.value,
              coverage: row.coverage,
              sourceMix: row.sourceMix,
              derivationVersion: row.derivationVersion,
            },
          }).run()
        }
        counts.providerDaily += mapped.rows.length
      }
      continue
    }

    if (t.target === 'sessions') {
      for (const page of pages) {
        const { sessions: rows, segments } = mapSessions({
          dataType: t, personId: input.personId, resolveSource,
          body: page.body, rawPayloadId: page.rawPayloadId,
        })
        for (const row of rows) {
          tx.insert(sessions).values(row).onConflictDoUpdate({
            target: [sessions.personId, sessions.sourceId, sessions.kind, sessions.externalId],
            set: {
              startMs: row.startMs,
              startOffsetMinutes: row.startOffsetMinutes,
              endMs: row.endMs,
              endOffsetMinutes: row.endOffsetMinutes,
              localDate: row.localDate,
              attrs: row.attrs,
              rawPayloadId: row.rawPayloadId,
            },
          }).run()
          localDates.add(row.localDate)
        }
        // Replaced wholesale for the sessions in this page, the same as ingest, a window fetched
        // twice legitimately revises a night's stage timeline, and merging both versions of it
        // would interleave them.
        for (const row of rows) {
          tx.delete(sessionSegments).where(eq(sessionSegments.sessionId, row.id)).run()
        }
        for (const segment of segments) tx.insert(sessionSegments).values(segment).run()
        counts.sessions += rows.length
        counts.segments += segments.length
      }
      continue
    }

    // Every page of the window at once. mapWindowSamples downsamples per minute across the whole
    // window, so a page at a time would collapse a minute spanning two pages twice and leave two
    // rows where the original sync left one.
    const rows = mapWindowSamples({ dataType: t, personId: input.personId, resolveSource, pages })
    for (const row of rows) {
      tx.insert(samples).values(row).onConflictDoUpdate({
        target: [samples.personId, samples.sourceId, samples.metric, samples.utcMs, samples.agg],
        set: {
          value: row.value,
          n: row.n,
          tzOffsetMinutes: row.tzOffsetMinutes,
          rawPayloadId: row.rawPayloadId,
        },
      }).run()
      localDates.add(localDateOf(row.utcMs, row.tzOffsetMinutes))
    }
    counts.samples += rows.length
  }

  counts.localDates = [...localDates].sort()
  return counts
}

interface Window {
  dataType: string
  isRollup: boolean
  pages: ArchivedPayload[]
}

/**
 * Puts the pages of a window back together.
 *
 * The archive stores one row per response, and a paginated list window is several. Grouping on
 * the data type and both window bounds reconstructs the call the pages came from, which is the
 * unit mapWindowSamples needs. Groups come out in the order their first page was listed, so a
 * window re-fetched later still replays after the one it corrects.
 */
function groupIntoWindows(payloads: readonly ArchivedPayload[]): Window[] {
  const byKey = new Map<string, Window>()
  for (const payload of payloads) {
    const isRollup = isRollupRequest(payload.requestParams)
    const key = `${payload.dataType} ${payload.windowStartMs} ${payload.windowEndMs} ${isRollup}`
    const existing = byKey.get(key)
    if (existing) { existing.pages.push(payload); continue }
    byKey.set(key, { dataType: payload.dataType, isRollup, pages: [payload] })
  }
  return [...byKey.values()]
}

/**
 * Which call fetched this payload. dailyRollUpDataPoints records a range and the list call
 * records a filter, and several data types answer both, so nothing else in the row can say.
 * An unparseable or unrecognised params blob reads as a list, which is what every payload
 * written before the rollup methods existed is.
 */
function isRollupRequest(requestParams: string): boolean {
  try {
    const parsed: unknown = JSON.parse(requestParams)
    return typeof parsed === 'object' && parsed !== null && 'range' in parsed
  } catch {
    return false
  }
}
