import { and, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily, samples, sessions, sessionSegments } from '../db/schema/index.ts'
import { dataTypeById } from '../api/catalogue.ts'
import { mapWindowSamples } from '../api/mapSamples.ts'
import { mapSessions } from '../api/mapSessions.ts'
import { mapRollups } from '../api/mapRollups.ts'
import { localDateOf } from '../derive/localDay.ts'
import { PROVIDER_SOURCE } from '../derive/rollup.ts'
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
  /** Every local date a replayed row landed on, which is what needs deriving after. */
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

    if (group.isRollup) {
      for (const page of group.pages) {
        const mapped = mapRollups({
          dataType: t, personId: input.personId,
          body: input.archive.getBody(input.personId, page.id),
        })
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
          // Deriving a rollup-only day writes no derived rows, so this looks like pointless
          // work, and it is not. deriveDayInto is the only thing in the system that ever applies
          // a day_metric exclusion to a PROVIDER_SOURCE row, and it only runs for the dates
          // named here. Leave them out and a day whose sole content is a provider figure is
          // never derived, so a correction somebody made on that figure is silently undone by
          // the next rebuild. Reachable in practice, because the rollup endpoints reach further
          // back than intraday retention: the oldest days a household carries commonly have a
          // provider row and no samples at all.
          localDates.add(row.localDate)
        }
      }
      continue
    }

    if (t.target === 'sessions') {
      // No lookup of a session's previous localDate here, unlike writeSessions in the live sync
      // path. That lookup exists to mark the day a session left dirty when Google revises its end
      // time across midnight, but the caller of replayPerson has already emptied this person's
      // tier 2, so every row inserted below is new: there is no previous row for any session to
      // have moved away from.
      for (const page of group.pages) {
        const { sessions: rows, segments } = mapSessions({
          dataType: t, personId: input.personId, resolveSource,
          body: input.archive.getBody(input.personId, page.id), rawPayloadId: page.id,
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
      }
      continue
    }

    // One mapWindowSamples call per fetch episode, oldest first, not one call over the whole
    // group. Pagination pages of a single fetch must still be mapped together, which is the
    // reason groupIntoWindows exists at all, so this splits WITHIN a group rather than reverting
    // to one call per page. splitIntoEpisodes reads the episode the client recorded where there
    // is one and infers it from pageToken where there is not. But runJob calls listDataPoints
    // once per sync run, and the trailing window is re-fetched on every run by design, so two
    // archived rows sharing a window's bounds are just as often two separate fetch episodes as
    // two pages of one. Merging them into a
    // single mapWindowSamples call would downsample across readings the original sync never saw
    // together: a minute Google revised from 60 bpm to 100 bpm between two fetches would leave
    // min 60, mean 80, max 100, n 2, where the sync itself left min 100, mean 100, max 100, n 1.
    for (const episode of splitIntoEpisodes(group.pages)) {
      const pages = episode.map((p) => ({
        body: input.archive.getBody(input.personId, p.id),
        rawPayloadId: p.id,
      }))
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
    }
  }

  // Measured against the table rather than accumulated from what each mapper call returned. The
  // trailing window is re-fetched on every sync run by design, so the same minute is commonly
  // mapped more than once and upserted onto the one row it always was; summing mapper output
  // would answer "how much work did the replay do" when the number a caller wants is "what is in
  // the database now". Every metric in ReplayCounts that a later task will surface to an operator
  // deciding whether their rebuild worked has to be this, or it is a plausible-looking lie.
  counts.samples = tx.select({ n: sql<number>`count(*)` })
    .from(samples).where(eq(samples.personId, input.personId)).get()?.n ?? 0
  counts.sessions = tx.select({ n: sql<number>`count(*)` })
    .from(sessions).where(eq(sessions.personId, input.personId)).get()?.n ?? 0
  counts.segments = tx.select({ n: sql<number>`count(*)` })
    .from(sessionSegments)
    .innerJoin(sessions, eq(sessionSegments.sessionId, sessions.id))
    .where(eq(sessions.personId, input.personId))
    .get()?.n ?? 0
  counts.providerDaily = tx.select({ n: sql<number>`count(*)` })
    .from(daily)
    .where(and(eq(daily.personId, input.personId), eq(daily.source, PROVIDER_SOURCE)))
    .get()?.n ?? 0

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
 * the data type and both window bounds reconstructs which window each page came from. It does
 * not by itself reconstruct which fetch a page came from: the trailing window is re-fetched on
 * every sync run by design, so several archived rows sharing one window's bounds are commonly
 * more than one fetch episode, not more than one page of a single fetch. splitIntoEpisodes,
 * below, is what tells those apart; this function only narrows to the right window and the right
 * call kind (list versus rollup).
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

/**
 * Splits one window's list pages back into the fetch episodes that produced them.
 *
 * A page archived by a client that records its fetch episode carries the id of the call it came
 * from, and pages sharing that id are one call no matter what else the row says. Reading the
 * grouping beats deriving it, and the three ways deriving it goes wrong are all real (issue 54):
 * a re-fetch whose first page was deduplicated leaves no null token to start its episode at, two
 * pages archived in the same millisecond are ordered by a random row id that can put a
 * continuation ahead of its own start, and a person moving west gives the same date earlier
 * window bounds. Each one silently merges a correction with the reading it corrects, and because
 * daily means are weighted by n, one blended minute reweights a whole day.
 *
 * A page whose id is null is not a gap. It is a row archived before the column existed, and a
 * live instance holds months of them: tier 1 is the only copy of what the API ever said, so those
 * rows must keep replaying exactly as they did, through the pageToken inference below. Both kinds
 * appear in the same window group for as long as the oldest windows survive, so the two rules run
 * side by side rather than one replacing the other.
 *
 * The inference: client.ts writes pageToken: pageToken ?? null on every archived list page, so
 * null marks the first page of a fetch and a string marks a continuation of the fetch before it.
 * listFor orders pages by fetch time within a window, and a paginated fetch is sequential, so
 * walking the array in order and starting a new episode at every null boundary recovers the
 * original calls: pagination pages of one fetch stay together, which is the reason
 * groupIntoWindows groups by window at all, and two separate fetches of the same window split
 * apart instead of being downsampled as if they were one call.
 *
 * Either way a window re-fetched later really does replay after, and correct, the episode before
 * it, because there is an "after": each episode is its own mapWindowSamples call and its own
 * round of upserts, in the order listFor returned them. Episodes are emitted in the order their
 * first page appears, which for a recorded id is the order the calls themselves ran in.
 *
 * If a re-fetch's first page came back byte-identical to what was already archived, RawArchive.put
 * deduplicated it and no new row exists at all. The stored row stays with the episode that first
 * archived it, and the re-fetch replays as whatever pages it did add: the deduplicated page would
 * have mapped to the same values it already did, so nothing is lost by not repeating it.
 */
function splitIntoEpisodes(pages: readonly ArchivedPayload[]): ArchivedPayload[][] {
  const episodes: ArchivedPayload[][] = []
  const recorded = new Map<string, ArchivedPayload[]>()
  // The inferred episode still open, if any. A page carrying an id closes it: the two rules must
  // not pour pages into each other's episodes, and a continuation token on a recorded page says
  // nothing about a call whose pages were never given ids.
  let inferred: ArchivedPayload[] | null = null

  for (const page of pages) {
    if (page.fetchEpisodeId !== null) {
      inferred = null
      const existing = recorded.get(page.fetchEpisodeId)
      if (existing) { existing.push(page); continue }
      const episode = [page]
      recorded.set(page.fetchEpisodeId, episode)
      episodes.push(episode)
      continue
    }
    if (inferred === null || isEpisodeStart(page.requestParams)) {
      inferred = [page]
      episodes.push(inferred)
      continue
    }
    inferred.push(page)
  }
  return episodes
}

/**
 * True for the first page of a fetch, false for a continuation page. A params blob with no
 * pageToken key at all, or one this cannot parse, defaults to true: treating an unrecognised page
 * as the start of its own episode never merges readings the original sync kept apart, which is
 * the failure mode this whole function exists to avoid.
 */
function isEpisodeStart(requestParams: string): boolean {
  try {
    const parsed: unknown = JSON.parse(requestParams)
    if (typeof parsed !== 'object' || parsed === null) return true
    return !('pageToken' in parsed) || (parsed as { pageToken: unknown }).pageToken === null
  } catch {
    return true
  }
}
