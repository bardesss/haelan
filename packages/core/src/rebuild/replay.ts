import { and, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily, observations, samples, sessions, sessionSegments } from '../db/schema/index.ts'
import { SampleKeys } from '../db/keys.ts'
import { dataTypeById } from '../api/catalogue.ts'
import { mapWindowSamples } from '../api/mapSamples.ts'
import { mapSessions } from '../api/mapSessions.ts'
import { mapRollups } from '../api/mapRollups.ts'
import { mapObservations } from '../api/mapObservations.ts'
import { localDateOf } from '../derive/localDay.ts'
import { PROVIDER_SOURCE } from '../derive/rollup.ts'
import type { ArchivedPayload, RawArchive } from '../store/rawArchive.ts'
import type { SourceRegistry } from '../store/sources.ts'
import { makeDropCollector, withPage } from './withPage.ts'
import type { Drop, PageConnection } from './withPage.ts'

/**
 * Consecutive dropped units that mean the environment is wrong rather than the data.
 *
 * Backs up isFatalRebuildError for whatever its code list does not know about. Consecutive
 * rather than total, so an archive carrying scattered bad pages never trips it however large it
 * grows, while a wholesale failure trips early and cheaply.
 */
const DROP_BREAKER = 100

export interface ReplayInput {
  personId: string
  payloads: readonly ArchivedPayload[]
  archive: RawArchive
  sources: SourceRegistry
  nowMs: number
  /**
   * The connection `tx` is running on, which is `db.$client` at every caller.
   *
   * Passed beside the transaction handle rather than derived from it because a drizzle
   * transaction handle has no `$client` - that is the whole reason `DbOrTx` exists (see
   * db/open.ts). withPage needs the connection to open and close its savepoints without
   * preparing a statement per unit, and the WHY comment there has the measurement. Handing it
   * in rather than reaching into drizzle's internals for it keeps the dependency on drizzle to
   * the one thing this file already relies on: that both handles are the same connection, so
   * statements issued through either join the same transaction.
   */
  client: PageConnection
}

export interface ReplayCounts {
  samples: number
  sessions: number
  segments: number
  providerDaily: number
  observations: number
  /** Payloads no current mapper claims. Reported rather than thrown, see below. */
  unmappable: number
  /** Every local date a replayed row landed on, which is what needs deriving after. */
  localDates: string[]
  /** Pages that threw and were skipped, so the rest of the archive could replay. */
  droppedPages: number
  /** Those pages grouped by data type and reason - see dropReason for why grouped. */
  drops: Drop[]
}

/**
 * Rebuilds one person's tier 2 from their archived payloads, through the mappers as they are
 * today rather than as they were when the payloads arrived.
 *
 * The caller owns the transaction and has already emptied the person's tier 2 and 3. Sources are
 * resolved fresh here rather than reused, which is the whole point of the milestone, an identity
 * the current describe() would no longer produce must not survive a rebuild.
 *
 * A unit that cannot be written costs that unit and nothing else. Every write below runs inside
 * its own savepoint (see withPage), so one page whose rows will not go in is skipped and counted
 * rather than rolling the person's whole transaction back. That is what #274 cost a real
 * instance: one archived body threw `UNIQUE constraint failed: session_segments.id`, the failure
 * was deterministic, so it repeated on every boot and the only person on the instance was
 * skipped by every sync run until a code change. Nothing is lost by dropping a unit - tier 1
 * still holds every body, so a later MAPPING_VERSION bump replays them with no operator action.
 * Three things still abort the whole person: a fatal SQLite code (isFatalRebuildError),
 * DROP_BREAKER consecutive drops, and a replay in which nothing at all committed.
 */
export function replayPerson(tx: DbOrTx, input: ReplayInput): ReplayCounts {
  const counts: ReplayCounts = {
    samples: 0, sessions: 0, segments: 0, providerDaily: 0, observations: 0,
    unmappable: 0, localDates: [], droppedPages: 0, drops: [],
  }
  // A dropped unit can leave its date in this set: the set is in memory and a savepoint rollback
  // does not revert it. Harmless rather than a bug - deriving a day whose rows are absent is a
  // no-op, and the day usually carries rows from other types anyway - and written down because
  // the alternative reading is that it is a leak.
  const localDates = new Set<string>()
  const resolveSource = (dataSource: unknown): string =>
    input.sources.resolve(input.personId, dataSource, input.nowMs, tx)
  // Bound to the caller's transaction handle and not kept anywhere beyond this call: a rebuild is
  // one transaction per person, and an instance shared across two would answer from cache for a
  // person whose rebuild rolled back. This is the hot path the cache exists for - a person's whole
  // archive replays through it, so a metric name costs one query rather than one per row.
  const keys = new SampleKeys(tx)

  // One collector for the whole person. The breaker counts consecutive failures across every
  // data type rather than per type: what it is there to catch is the environment going wrong
  // mid-replay, which is not confined to one type's pages.
  const collector = makeDropCollector()
  let committedUnits = 0
  const breaker = (): void => {
    if (collector.consecutive < DROP_BREAKER) return
    throw new Error(
      `${DROP_BREAKER} consecutive pages could not be replayed for ${input.personId}, `
      + 'which is an environment fault rather than bad data, so the rebuild is abandoned '
      + `rather than committing a near-empty archive: ${collector.lastReason ?? ''}`,
    )
  }

  /**
   * What has to happen after every unit, whether it committed or not.
   *
   * The two caches above are the reason this is not just `breaker()`. Both resolve an identifier
   * to a row and remember the answer, and both write the row when it is missing: SourceRegistry
   * inserts into `sources` on first sight of a dataSource, SampleKeys inserts into `metrics` on
   * first sight of a metric name. Both were written assuming they never outlive a rollback of
   * what they wrote - SampleKeys' class comment says so outright, and SourceRegistry.forget
   * exists for the one caller that did - and a savepoint rollback is exactly the rollback they
   * now do outlive. Left alone, a unit that dropped after resolving a new source hands the next
   * unit an id whose row is gone, so that one fails its foreign key too, and so does every unit
   * after it until the breaker fires: one bad page would cost the person their archive by a
   * longer route than the one this change removes. A metric ref is worse than a foreign key
   * failure, because `metrics.ref` is AUTOINCREMENT and `sqlite_sequence` rolls back with
   * everything else, so the number is handed out again to whatever metric is inserted next and
   * the stale cache would file one metric's readings under another's name with nothing failing
   * at all. Clearing both costs one select per identifier on the next unit that needs it.
   */
  const afterUnit = (committed: boolean): void => {
    if (committed) committedUnits += 1
    else {
      input.sources.forget(input.personId)
      keys.forget()
    }
    breaker()
  }

  // Prepared once for the whole replay rather than rebuilt per row, and this is a memory fix
  // rather than a speed one. Drizzle compiles and prepares a fresh better-sqlite3 statement on
  // every `insert().values().run()`, and better-sqlite3 holds on to every statement a connection
  // prepares so it can finalise them when the connection closes. Inside one long transaction
  // nothing releases them, so the old loop leaked a statement per row written: measured at about
  // 2.8 KB a row, which is what took a rebuild of a real archive past 5 GB and had the worker
  // OOM-killed on a memory capped host (#275). The same 400,000 rows through the statement below
  // hold flat. Samples get this treatment first because they are the overwhelming majority of the
  // rows a replay writes; the other four loops in this function have the same shape and, on a
  // household archive, a tiny fraction of the volume.
  const insertSample = tx.insert(samples).values({
    personRef: sql.placeholder('personRef'),
    sourceRef: sql.placeholder('sourceRef'),
    metricRef: sql.placeholder('metricRef'),
    utcMs: sql.placeholder('utcMs'),
    tzOffsetMinutes: sql.placeholder('tzOffsetMinutes'),
    aggRef: sql.placeholder('aggRef'),
    value: sql.placeholder('value'),
    n: sql.placeholder('n'),
    rawPayloadRef: sql.placeholder('rawPayloadRef'),
  } as unknown as typeof samples.$inferInsert).onConflictDoUpdate({
    // The same five columns, in the same order, as the loop this replaced and as runJob's
    // writeSamples. The comment on `samples_natural` says why the three have to move together.
    target: [samples.personRef, samples.sourceRef, samples.metricRef, samples.utcMs, samples.aggRef],
    set: {
      value: sql.placeholder('value'),
      n: sql.placeholder('n'),
      tzOffsetMinutes: sql.placeholder('tzOffsetMinutes'),
      rawPayloadRef: sql.placeholder('rawPayloadRef'),
    } as unknown as Partial<typeof samples.$inferInsert>,
  }).prepare()

  for (const group of groupIntoWindows(input.payloads)) {
    const t = dataTypeById(group.dataType)
    // A data type the catalogue no longer describes leaves payloads nobody can map. Counted and
    // reported rather than thrown, because one retired type must not cost a person the rebuild
    // of every other type they have. The bodies stay in tier 1 either way.
    if (t === undefined) { counts.unmappable += group.pages.length; continue }

    if (group.isRollup) {
      for (const page of group.pages) {
        const committed = withPage(input.client, { dataType: group.dataType, pages: 1 }, collector, () => {
          const mapped = mapRollups({
            dataType: t, personId: input.personId,
            body: input.archive.getBody(input.personId, page.id),
          })
          for (const row of mapped.rows) {
            tx.insert(daily).values({ ...row, updatedAtMs: input.nowMs }).onConflictDoUpdate({
              target: [daily.personId, daily.localDate, daily.metric, daily.agg, daily.source],
              set: {
                value: row.value,
                coverage: row.coverage,
                sourceMix: row.sourceMix,
                derivationVersion: row.derivationVersion,
                updatedAtMs: input.nowMs,
              },
            }).run()
            // Deriving a rollup-only day writes no derived rows, so this looks like pointless
            // work, and it is not. deriveDayInto is the only thing in the system that ever
            // applies a day_metric exclusion to a PROVIDER_SOURCE row, and it only runs for the
            // dates named here. Leave them out and a day whose sole content is a provider figure
            // is never derived, so a correction somebody made on that figure is silently undone
            // by the next rebuild. Reachable in practice, because the rollup endpoints reach
            // further back than intraday retention: the oldest days a household carries commonly
            // have a provider row and no samples at all.
            localDates.add(row.localDate)
          }
        })
        afterUnit(committed)
      }
      continue
    }

    // ECG (and any future type like it) names one primary target plus alsoTargets, and one
    // archived page has to replay into each: the branch below used to run only for t.target,
    // which is what let a rebuild delete the alsoTargets rows a live sync had written and never
    // put them back. runJob.ts's writeFor has the identical shape and the identical reason
    // (runJob.ts:154): every mapper already accepts a foreign-looking dataType through its own
    // "target is mine, or alsoTargets includes mine" guard, so running one branch per named
    // target is the other half of that contract.
    for (const target of [t.target, ...(t.alsoTargets ?? [])]) {
      if (target === 'sessions') {
        // No lookup of a session's previous localDate here, unlike writeSessions in the live sync
        // path. That lookup exists to mark the day a session left dirty when Google revises its end
        // time across midnight, but the caller of replayPerson has already emptied this person's
        // tier 2, so every row inserted below is new: there is no previous row for any session to
        // have moved away from.
        for (const page of group.pages) {
          const committed = withPage(input.client, { dataType: group.dataType, pages: 1 }, collector, () => {
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
            // Replaced wholesale for the sessions in this page, the same as ingest, a window
            // fetched twice legitimately revises a night's stage timeline, and merging both
            // versions of it would interleave them.
            for (const row of rows) {
              tx.delete(sessionSegments).where(eq(sessionSegments.sessionId, row.id)).run()
            }
            for (const segment of segments) tx.insert(sessionSegments).values(segment).run()
          })
          afterUnit(committed)
        }
        continue
      }

      if (target === 'observations') {
        // One mapObservations call per page, the same granularity writeObservations in runJob.ts
        // uses. Unlike samples there is no coverage or aggregate to get wrong by mapping a page on
        // its own, so there is no reason to reassemble fetch episodes the way the samples path below
        // has to.
        for (const page of group.pages) {
          const committed = withPage(input.client, { dataType: group.dataType, pages: 1 }, collector, () => {
            const rows = mapObservations({
              dataType: t, personId: input.personId, resolveSource,
              body: input.archive.getBody(input.personId, page.id), rawPayloadId: page.id,
            })
            for (const row of rows) {
              tx.insert(observations).values(row).onConflictDoUpdate({
                target: observations.id,
                set: {
                  personId: row.personId,
                  sourceId: row.sourceId,
                  kind: row.kind,
                  startedAtMs: row.startedAtMs,
                  startedAtOffsetMinutes: row.startedAtOffsetMinutes,
                  endedAtMs: row.endedAtMs,
                  endedAtOffsetMinutes: row.endedAtOffsetMinutes,
                  localDate: row.localDate,
                  value: row.value,
                  rawPayloadId: row.rawPayloadId,
                },
              }).run()
              localDates.add(row.localDate)
            }
          })
          afterUnit(committed)
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
      // two pages of one. Merging them into a single mapWindowSamples call would downsample
      // across readings the original sync never saw
      // together: a minute Google revised from 60 bpm to 100 bpm between two fetches would leave
      // min 60, mean 80, max 100, n 2, where the sync itself left min 100, mean 100, max 100, n 1.
      for (const episode of splitIntoEpisodes(group.pages)) {
        // The whole episode is one unit, where the three loops above take a page each. Not an
        // inconsistency: mapWindowSamples takes a fetch episode, and isolating a page inside one
        // would mean calling it once per page, which downsamples across readings the original
        // sync deliberately kept apart - the exact failure splitIntoEpisodes exists to prevent,
        // and the comment above it spells out what a blended minute costs. A dropped episode
        // therefore costs every page in it, which is why `pages` is its length rather than 1:
        // the number an operator reads has to be how much of the archive went unreplayed, not
        // how many times this loop gave up.
        const unit = { dataType: group.dataType, pages: episode.length }
        const committed = withPage(input.client, unit, collector, () => {
          const pages = episode.map((p) => ({
            body: input.archive.getBody(input.personId, p.id),
            rawPayloadId: p.id,
          }))
          const rows = mapWindowSamples({ dataType: t, personId: input.personId, resolveSource, pages })
          for (const row of rows) {
            // The same translation and the same upsert target runJob's writeSamples uses, and
            // they have to stay the same: a replay that keyed a row differently from the sync
            // would upsert onto a key the sync never wrote and double the table on the first
            // rebuild.
            const stored = keys.sampleRefs(row)
            insertSample.run(stored)
            localDates.add(localDateOf(row.utcMs, row.tzOffsetMinutes))
          }
        })
        afterUnit(committed)
      }
    }
  }

  // The second breaker, and the one that catches what DROP_BREAKER cannot.
  //
  // A hundred consecutive drops is a threshold, so an archive smaller than a hundred units can
  // never reach it: a household member with forty archived pages, all failing for an
  // environmental reason isFatalRebuildError's code list does not know, would be stamped current
  // carrying an empty tier 2, their sync resumed, and their history simply gone. That is the
  // silent corruption fatalError.ts says has to be impossible rather than merely visible, and
  // the threshold left it merely visible for every small archive.
  //
  // Categorical rather than a fraction: "not one unit went in" is a fact about the replay, where
  // any percentage would be a number nobody can defend. And it keys on having dropped something,
  // not on having committed nothing. A person whose every payload belongs to a data type the
  // catalogue retired replays to nothing too, and that is an ordinary answer rather than a fault
  // - those payloads are counted in `unmappable`, no error was raised, and abandoning them would
  // quarantine a person for the crime of holding only old data.
  if (committedUnits === 0 && collector.droppedPages > 0) {
    throw new Error(
      `nothing at all could be replayed for ${input.personId}: every one of the `
      + `${collector.droppedPages} archived pages that were tried failed and none committed, `
      + 'which is an environment fault rather than bad data, so the rebuild is abandoned rather '
      + `than stamping the person with an empty archive: ${collector.lastReason ?? ''}`,
    )
  }

  // Measured against the table rather than accumulated from what each mapper call returned. The
  // trailing window is re-fetched on every sync run by design, so the same minute is commonly
  // mapped more than once and upserted onto the one row it always was; summing mapper output
  // would answer "how much work did the replay do" when the number a caller wants is "what is in
  // the database now". Every metric in ReplayCounts that a later task will surface to an operator
  // deciding whether their rebuild worked has to be this, or it is a plausible-looking lie.
  counts.samples = tx.select({ n: sql<number>`count(*)` })
    .from(samples).where(eq(samples.personRef, keys.personRef(input.personId))).get()?.n ?? 0
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
  counts.observations = tx.select({ n: sql<number>`count(*)` })
    .from(observations).where(eq(observations.personId, input.personId)).get()?.n ?? 0

  counts.localDates = [...localDates].sort()
  // Straight off the collector rather than measured against a table, unlike the five counts
  // above: what was skipped left nothing behind to count, so the collector is the only record
  // there is.
  counts.droppedPages = collector.droppedPages
  counts.drops = collector.list()
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
