import { afterEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { MAPPING_VERSION } from '../src/api/version.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import {
  daily, overrides, people, samples, sessions, sources, sourcePriority, syncState,
} from '../src/db/schema/index.ts'
import { sessionTarget } from '../src/derive/targetKey.ts'

// Builds a database holding one person, one archived heart rate window and one archived sleep
// window, plus a sync_state row. Returns the handles runRebuild needs.
import {
  seedOverride, seedRebuildable, seedSession, REBUILDABLE_SLEEP_EXTERNAL_ID,
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
    const otherRows = h.seedSecondPerson()

    runRebuild({ ...h.deps, nowMs: 1, personIds: [h.personId] })

    expect(h.db.select().from(samples).where(eq(samples.personId, 'p2')).all()).toEqual(otherRows)
  })

  test('a person whose replay throws leaves that person entirely unchanged', () => {
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })
    const before = h.db.select().from(daily).all()
    h.corruptOneArchivedBody()

    expect(() => runRebuild({ ...h.deps, nowMs: 2, force: true })).toThrow()

    expect(h.db.select().from(daily).all()).toEqual(before)
    // The stamp is written inside the same transaction, so a rollback has to take it too.
    // Otherwise a person survives a failed rebuild looking rebuilt, and no later boot retries.
    const row = h.db.select().from(people).where(eq(people.id, h.personId)).get()!
    expect(row.builtMappingVersion).toBe(MAPPING_VERSION)
  })

  test('reports each person as it commits, so a caller can log progress', () => {
    h = seedRebuildable()
    const seen: string[] = []

    runRebuild({ ...h.deps, nowMs: 1, onPersonDone: (r) => seen.push(r.personId) })

    expect(seen).toEqual([h.personId])
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
  })
})
