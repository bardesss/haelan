import { afterEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { MAPPING_VERSION } from '../src/api/version.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import {
  daily, overrides, people, samples, sessions, sessionSegments, sources, sourcePriority, syncState,
} from '../src/db/schema/index.ts'
import { dayMetricTarget, sessionTarget } from '../src/derive/targetKey.ts'
import { dailyRollupBody } from '../src/testing/payloads.ts'
import { PROVIDER_SOURCE } from '../src/derive/rollup.ts'

// Builds a database holding one person, one archived heart rate window and one archived sleep
// window, plus a sync_state row. Returns the handles runRebuild needs.
import {
  seedOverride, seedRebuildable, seedSession,
  REBUILDABLE_DATE, REBUILDABLE_SLEEP_EXTERNAL_ID,
} from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

let h: Rebuildable
afterEach(() => { h.cleanup() })

describe('runRebuild', () => {
  test('regenerates tier 2 and tier 3 from the archive alone', () => {
    h = seedRebuildable()
    h.db.delete(daily).run()
    h.db.delete(samples).run()

    const report = runRebuild({ ...h.deps, nowMs: 1 })

    expect(report.people).toHaveLength(1)
    expect(report.people[0]!.samples).toBeGreaterThan(0)
    expect(report.people[0]!.dailyRows).toBeGreaterThan(0)
    expect(h.db.select().from(samples).all().length).toBe(report.people[0]!.samples)
    // The sleep window derives as well as the heart rate one. This is also what keeps the
    // session override test at the bottom of this file honest: that test asserts the sleep rows
    // are absent once the night is excluded, which proves nothing unless they are here when it
    // is not.
    expect(h.db.select().from(daily).all().some((r) => r.metric.startsWith('sleep_'))).toBe(true)
  })

  test('stamps the person with the versions the work was done at', () => {
    h = seedRebuildable()

    runRebuild({ ...h.deps, nowMs: 1 })

    const row = h.db.select().from(people).where(eq(people.id, h.personId)).get()!
    expect(row.builtMappingVersion).toBe(MAPPING_VERSION)
    expect(row.builtDerivationVersion).toBe(DERIVATION_VERSION)
    // The same two columns read back through PeopleStore, not just off the row. What decides
    // whether a person rebuilds again is peopleNeedingRebuild comparing against what the store
    // returns, so a get() that dropped either field would compare a constant against undefined
    // and rebuild everybody on every boot forever, with the table above looking perfectly right.
    const viaStore = h.deps.peopleStore.get(h.personId)!
    expect(viaStore.builtMappingVersion).toBe(MAPPING_VERSION)
    expect(viaStore.builtDerivationVersion).toBe(DERIVATION_VERSION)
  })

  test('skips a person already stamped at the current versions', () => {
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })

    const second = runRebuild({ ...h.deps, nowMs: 2 })

    expect(second.people).toEqual([])
  })

  test('rebuilds a stamped person anyway when forced', () => {
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })

    const forced = runRebuild({ ...h.deps, nowMs: 2, force: true })

    expect(forced.people).toHaveLength(1)
    // The night and its two stage rows were replaced, not duplicated. A session that comes back
    // under the same id has its segments cleared by the replay itself, so this pins the replace,
    // not the cascade; the orphan case the cascade actually covers is at the bottom of the file.
    expect(h.db.select().from(sessions).all()).toHaveLength(1)
    expect(h.db.select().from(sessionSegments).all()).toHaveLength(2)
  })

  test('a source the current mapping no longer produces does not survive', () => {
    h = seedRebuildable()
    // A row from before describe() widened, with a ranking pointing at it.
    h.db.insert(sources).values({
      id: 'stale', personId: h.personId, externalId: 'HEALTH_CONNECT',
      displayName: 'HEALTH_CONNECT', kind: 'app', createdAtMs: 1,
    }).run()
    h.db.insert(sourcePriority).values({
      personId: h.personId, metric: 'heart_rate', sourceId: 'stale', rank: 0,
    }).run()

    const report = runRebuild({ ...h.deps, nowMs: 1 })

    expect(h.db.select().from(sources).where(eq(sources.id, 'stale')).all()).toEqual([])
    expect(h.db.select().from(sourcePriority).where(eq(sourcePriority.sourceId, 'stale')).all()).toEqual([])
    expect(report.people[0]!.sourcesRemoved).toBe(1)
  })

  test('leaves sync state alone, because a rebuild is not a re-fetch', () => {
    h = seedRebuildable()
    const before = h.db.select().from(syncState).all()

    runRebuild({ ...h.deps, nowMs: 1 })

    expect(h.db.select().from(syncState).all()).toEqual(before)
  })

  test('running it twice leaves the same rows', () => {
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })
    const first = h.db.select().from(daily).all()

    runRebuild({ ...h.deps, nowMs: 2, force: true })

    expect(h.db.select().from(daily).all()).toEqual(first)
  })

  test('one person\'s rebuild does not touch another\'s rows', () => {
    h = seedRebuildable()
    const other = h.seedSecondPerson()

    runRebuild({ ...h.deps, nowMs: 1, personIds: [h.personId] })

    // All three tables the person transaction empties, not just samples. A delete that lost its
    // person filter on sessions or on daily is one household member losing another's nights or
    // another's dashboard while somebody else rebuilds, which this project treats as a
    // correctness bug rather than a nicety.
    expect(h.db.select().from(samples).where(eq(samples.personId, 'p2')).all()).toEqual(other.samples)
    expect(h.db.select().from(sessions).where(eq(sessions.personId, 'p2')).all()).toEqual(other.sessions)
    expect(h.db.select().from(daily).where(eq(daily.personId, 'p2')).all()).toEqual(other.daily)
  })

  test('a person whose replay throws leaves that person entirely unchanged', () => {
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })
    const before = h.db.select().from(daily).all()
    // Back to what a database predating M2e looks like: rows already derived, no stamp, so the
    // next run picks this person up without being forced. The un-stamping is the whole point.
    // Asserting the stamp after a run that already succeeded proves nothing, because the value a
    // rolled back stamp leaves behind and the value a leaked one writes are the same number.
    h.db.update(people).set({ builtMappingVersion: null, builtDerivationVersion: null })
      .where(eq(people.id, h.personId)).run()
    h.corruptOneArchivedBody()

    expect(() => runRebuild({ ...h.deps, nowMs: 2 })).toThrow()

    expect(h.db.select().from(daily).all()).toEqual(before)
    expect(h.db.select().from(samples).all().length).toBeGreaterThan(0)
    // The stamp is written inside the same transaction, so a rollback has to take it too.
    // Otherwise a person survives a failed rebuild looking rebuilt, no later boot retries them,
    // and they keep stale derived rows with nothing anywhere reporting a problem.
    const row = h.db.select().from(people).where(eq(people.id, h.personId)).get()!
    expect(row.builtMappingVersion).toBeNull()
    expect(row.builtDerivationVersion).toBeNull()
  })

  test('reports each person as it commits, so a caller can log progress', () => {
    h = seedRebuildable()
    const seen: string[] = []

    runRebuild({ ...h.deps, nowMs: 1, onPersonDone: (r) => seen.push(r.personId) })

    expect(seen).toEqual([h.personId])
  })

  test('a provider daily row the current mapping no longer produces does not survive', () => {
    h = seedRebuildable()
    // A provider figure from a mapping that has since changed its mind about the metric.
    // deriveDayInto spares PROVIDER_SOURCE rows on purpose, since nothing it computes could
    // recreate one, so the rebuild's own unqualified daily delete is the ONLY thing in the
    // system that ever clears one. Narrow that delete and this row outlives every mapping
    // change forever while the rebuild goes on reporting success.
    h.db.insert(daily).values({
      personId: h.personId, localDate: REBUILDABLE_DATE, metric: 'floors', agg: 'sum',
      source: PROVIDER_SOURCE, value: 12, coverage: null, sourceMix: null, derivationVersion: 1,
    }).run()

    const report = runRebuild({ ...h.deps, nowMs: 1 })

    // Exactly the provider rows the replay put back from the archived rollup, and nothing else.
    const provider = h.db.select().from(daily).where(eq(daily.source, PROVIDER_SOURCE)).all()
    expect(provider.map((r) => r.metric)).toEqual(['total_calories'])
    // dailyRows is the derived rows plus counts.providerDaily, so it can only equal what the
    // table holds if the stale provider row went and the archived one came back.
    expect(report.people[0]!.dailyRows).toBe(h.db.select().from(daily).all().length)
  })

  test('a day metric exclusion on a rollup-only day survives the rebuild', () => {
    h = seedRebuildable()
    // A day whose only content is a provider rollup row, which is an ordinary shape rather than a
    // contrived one: the rollup endpoints reach further back than intraday retention, so the
    // oldest days a household has commonly carry a provider figure and no samples at all.
    const lonelyDate = '2026-07-04'
    const lonelyWindowStart = Date.parse(`${lonelyDate}T00:00:00Z`)
    h.deps.archive.put({
      personId: h.personId, dataType: 'total-calories',
      requestParams: { range: { start: {}, end: {} } },
      windowStartMs: lonelyWindowStart, windowEndMs: lonelyWindowStart + 86_400_000,
      fetchedAtMs: 1, httpStatus: 200,
      body: dailyRollupBody('totalCalories', [
        { date: { year: 2026, month: 7, day: 4 }, value: { kcalSum: 1900 } },
      ]),
    })
    // The correction somebody made on that figure. deriveDayInto is the only thing in the system
    // that ever applies a day metric exclusion to a PROVIDER_SOURCE row, so a rebuild that never
    // derives this day puts the excluded calorie figure straight back on their dashboard, with
    // nothing anywhere saying it did.
    seedOverride(h.db, {
      personId: h.personId, scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: lonelyDate, metric: 'total_calories' }),
      action: 'exclude',
    })

    runRebuild({ ...h.deps, nowMs: 1 })

    const onThatDay = h.db.select().from(daily).where(eq(daily.localDate, lonelyDate)).all()
    expect(onThatDay).toEqual([])
    // And the day really did carry a provider row to throw away, so an assertion that passed
    // because the replay never wrote one would not read as a pass.
    const stillThere = h.db.select().from(daily).where(eq(daily.localDate, REBUILDABLE_DATE)).all()
    expect(stillThere.some((r) => r.source === PROVIDER_SOURCE)).toBe(true)
  })

  test('every person who needs it is rebuilt, each from their own archive', () => {
    h = seedRebuildable()
    h.seedSecondPerson()

    const report = runRebuild({ ...h.deps, nowMs: 1 })

    expect(report.people.map((r) => r.personId).sort()).toEqual(['p1', 'p2'])
    expect(report.people.every((r) => r.samples > 0)).toBe(true)
    // Each person's sources are resolved from their own payloads. p2's archive claims a
    // different platform and package, so the two must not come out sharing a source row.
    const owners = h.db.select().from(sources).all()
    expect(new Set(owners.map((r) => r.personId))).toEqual(new Set(['p1', 'p2']))
    expect(new Set(owners.map((r) => r.id)).size).toBe(owners.length)
  })

  test('a session override follows its session, and the derivation sees the move', () => {
    h = seedRebuildable()
    // The archived night as an earlier mapping filed it: the same kind and external id, under a
    // source id the current describe() no longer produces. A session id is derived from its
    // source, so the rebuild gives this night a different row id and the override has to follow.
    seedSession(h.db, {
      id: 'old-night', personId: h.personId,
      kind: 'sleep', externalId: REBUILDABLE_SLEEP_EXTERNAL_ID,
    })
    seedOverride(h.db, {
      personId: h.personId, scope: 'session',
      targetKey: sessionTarget('old-night'), action: 'exclude',
    })
    // A stage row under the old id. This is the only shape that exercises the cascade: the
    // session does not come back under this id, so the replay's own per session segment delete
    // never names it, and nothing but ON DELETE cascade can take it away.
    h.db.insert(sessionSegments).values({
      id: 'old-stage', sessionId: 'old-night', stage: 'LIGHT', startMs: 0, endMs: 1,
    }).run()

    const report = runRebuild({ ...h.deps, nowMs: 1 })

    const night = h.db.select().from(sessions).where(eq(sessions.personId, h.personId)).get()!
    expect(night.id).not.toBe('old-night')
    // Only reachable if the old session's identity was captured before the delete emptied tier 2,
    // and if the re-target ran after the replay had put the new row back. Either step out of
    // order leaves this override orphaned instead.
    expect(report.people[0]!.overridesRetargeted).toBe(1)
    expect(report.people[0]!.overridesOrphaned).toEqual([])
    expect(h.db.select().from(overrides).all()[0]!.targetKey).toBe(sessionTarget(night.id))
    // And the derivation ran after the move rather than before it. Deriving first would apply a
    // key naming a session id that no longer exists, and the night somebody threw out would be
    // rolled up as though they never had.
    expect(h.db.select().from(daily).all().filter((r) => r.metric.startsWith('sleep_'))).toEqual([])
    // And no stage row outlived the session it described. runRebuild deletes sessions and lets
    // session_segments' ON DELETE cascade take their segments, which only fires because
    // openDatabase sets PRAGMA foreign_keys = ON on every connection it makes.
    const liveSessionIds = new Set(h.db.select().from(sessions).all().map((r) => r.id))
    const orphans = h.db.select().from(sessionSegments).all()
      .filter((sg) => !liveSessionIds.has(sg.sessionId))
    expect(orphans).toEqual([])
  })
})
