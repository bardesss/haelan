import { createHash } from 'node:crypto'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { eq } from 'drizzle-orm'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { sourceAliases, sources } from '../src/db/schema/index.ts'
import { SourceAliasStore } from '../src/store/sourceAliases.ts'
import { SourceVisibilityStore } from '../src/store/sourceVisibility.ts'
import { insertSample, openRebuildLab, readSamples, seedRebuildable } from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

const idFor = (personId: string, externalId: string): string =>
  createHash('sha256').update(`${personId} ${externalId}`).digest('hex').slice(0, 32)

describe('rebuild re-derives source identity', () => {
  let h: Rebuildable
  afterEach(() => { h.cleanup() })

  test('a source written before describe() widened does not survive the rebuild', () => {
    // An app reporting through Health Connect with no device between it and the platform. Before
    // describe() took the package name, every such app collapsed onto one source called after the
    // platform alone; a scale app and a food diary became one source nobody could choose between.
    h = seedRebuildable({
      dataSource: {
        platform: 'HEALTH_CONNECT',
        application: { packageName: 'com.example.scale' },
      },
    })
    const stale = idFor(h.personId, 'HEALTH_CONNECT')
    h.db.insert(sources).values({
      id: stale, personId: h.personId, externalId: 'HEALTH_CONNECT',
      displayName: 'HEALTH_CONNECT', kind: 'app', createdAtMs: 1,
    }).run()

    runRebuild({ ...h.deps, nowMs: 1, force: true })

    const rows = h.db.select().from(sources).where(eq(sources.personId, h.personId)).all()
    expect(rows.map((r) => r.externalId)).toEqual(['HEALTH_CONNECT:com.example.scale'])
    expect(rows[0]!.id).toBe(idFor(h.personId, 'HEALTH_CONNECT:com.example.scale'))
    // And nothing is left pointing at the identity that came off the disk.
    expect(readSamples(h.db).filter((row) => row.sourceId === stale)).toEqual([])
  })
})

// Every property below shares one lab: openRebuildLab pays for a fresh sqlite file and its seven
// migrations exactly once for the whole file, and reset() between fast-check iterations clears
// rows instead. seedRebuildable's own "one live database at a time" contract is a separate
// mechanism scoped to itself; this lab is a second, independent handle, which is fine because
// nothing here holds two of the SAME kind of handle open at once.
const lab = openRebuildLab()
afterAll(() => { lab.cleanup() })

// One data source, in the shape that describe() (packages/core/src/store/sources.ts) reads:
// platform is always present, device and application are each optionally present, and
// recordingMethod distinguishes a manual entry from an automatic one. Generated rather than
// hand-written so the properties below cover shapes nobody thought to write a concrete test for.
const dataSourceArb = fc.record({
  platform: fc.constantFrom('FITBIT', 'HEALTH_CONNECT', 'GOOGLE_FIT'),
  device: fc.option(fc.record({ displayName: fc.constantFrom('Pixel Watch', 'Pixel 8') }), { nil: undefined }),
  application: fc.option(fc.record({ packageName: fc.constantFrom('com.a.app', 'com.b.app') }), { nil: undefined }),
  recordingMethod: fc.constantFrom('MANUAL', 'AUTOMATICALLY_RECORDED', 'DERIVED'),
}, { requiredKeys: ['platform', 'recordingMethod'] })

type GeneratedDataSource = { platform: string, recordingMethod: string, device?: { displayName: string }, application?: { packageName: string } }

// True exactly for the payload shapes describe()'s widening actually re-keyed: no device (a
// device name would already have been "who" before the widening), and either a package name or
// the manual flag, both of which the pre-widening describe() ignored. For these, and only these,
// the pre-widening code collapsed the payload onto the platform alone.
const widensThis = (ds: GeneratedDataSource): boolean =>
  ds.device === undefined && (ds.application !== undefined || ds.recordingMethod === 'MANUAL')

// True for a payload the widening never touched at all: no device, no package, not manual. Under
// BOTH the current describe() and the pre-widening one this resolves to the platform alone, so it
// is not evidence of anything breaking. It matters here because fast-check generates whole arrays:
// a run that first found this by hand generated GOOGLE_FIT/AUTOMATICALLY_RECORDED alongside
// GOOGLE_FIT/MANUAL in the same array. The MANUAL entry widens and correctly leaves the platform
// alone; the AUTOMATICALLY_RECORDED entry never needed widening and legitimately keeps resolving
// to the platform alone under today's correct code, which reuses whatever row already carries that
// identity. Asserting the platform-alone row must vanish would have been wrong in that case, not a
// bug in the rebuild: a live descriptor in the very same array was still supposed to produce it.
const passesThrough = (ds: GeneratedDataSource): boolean =>
  ds.device === undefined && ds.application === undefined && ds.recordingMethod !== 'MANUAL'

// Each fast-check run against the lab creates a sqlite savepoint's worth of work instead of a
// fresh file: reset() deletes rows and reseeds, runRebuild does one transaction. The migration
// cost that used to dominate seedRebuildable's per-call time is gone, which is why numRuns: 50
// fits inside vitest's default 20s budget even under the full suite's parallelism (measured, see
// the report). No per-test timeout override anywhere in this file: issue #32 raised four
// sync-runner tests to their own SPRINT_BUDGET_MS instead of making their setup cheaper, and
// issue #47 is open right now because those same tests flake on timeout again anyway. Where a
// property does not fit the budget, it runs fewer cases instead; see the one below that does.
describe('rebuild source identity, as a property', () => {
  test('no unreferenced identity survives, and every surviving one is derived', () => {
    fc.assert(fc.property(
      fc.array(dataSourceArb, { minLength: 1, maxLength: 4 }),
      // Identities that could only have come from an older mapping. The prefix guarantees they
      // cannot collide with anything describe() produces, which always begins with a platform.
      // Nothing references these rows, so this property is about pruning, hash consistency and
      // orphan-free samples; see the two properties below for the widening itself.
      fc.array(fc.constantFrom('stale-a', 'stale-b', 'stale-c'), { maxLength: 3 }),
      (dataSources, staleIds) => {
        lab.reset({ dataSources })
        for (const externalId of new Set(staleIds)) {
          lab.db.insert(sources).values({
            id: idFor(lab.personId, externalId), personId: lab.personId, externalId,
            displayName: externalId, kind: 'app', createdAtMs: 1,
          }).run()
        }

        runRebuild({ ...lab.deps, nowMs: 1, force: true })

        const rows = lab.db.select().from(sources).where(eq(sources.personId, lab.personId)).all()
        // Nothing that came off the disk unreferenced is still here.
        expect(rows.filter((r) => r.externalId.startsWith('stale-'))).toEqual([])
        // Every id is the hash of the identity beside it, rather than whatever was stored.
        for (const row of rows) expect(row.id).toBe(idFor(lab.personId, row.externalId))
        // And no sample points at a source that is gone.
        const live = new Set(rows.map((r) => r.id))
        const orphans = readSamples(lab.db, lab.personId)
          .filter((row) => !live.has(row.sourceId))
        expect(orphans).toEqual([])
      },
    ), { numRuns: 50 })
  })

  // The only property here that runs fewer than 50 cases, for two reasons that both point the
  // same way. It does twice the work of any other case, two full runRebuild calls and two
  // snapshot() calls, which is what took it to 22.8s under the loaded full suite against
  // vitest's 20s default while it passed in about 4s running alone. And idempotence is a
  // property that fails on its first counterexample rather than one needing a wide search: a
  // rebuild that is not a fixed point is not a fixed point for almost any input, so the extra
  // 35 cases buy coverage of the same defect over and over. Fewer cases rather than a raised
  // budget on purpose, since a raised budget is exactly what issue #47 is open about.
  test('a second rebuild changes nothing', () => {
    fc.assert(fc.property(
      fc.array(dataSourceArb, { minLength: 1, maxLength: 4 }),
      (dataSources) => {
        lab.reset({ dataSources })
        runRebuild({ ...lab.deps, nowMs: 1, force: true })
        const first = lab.snapshot()

        runRebuild({ ...lab.deps, nowMs: 2, force: true })

        expect(lab.snapshot()).toEqual(first)
      },
    ), { numRuns: 15 })
  })

  // This is the property the master design actually asks for. Seeding a made up "stale-*" row
  // (as the property above does) is unreferenced from the start, so dropUnreferencedSources
  // removes it no matter what identity the current describe() produces; that property cannot
  // fail from a broken describe() alone. This one seeds the identity the PRE-WIDENING describe()
  // would genuinely have written for a generated payload, which the replay's own resolveSource
  // reuses instead of replacing whenever the widening that distinguishes it has been undone.
  test('no pre-widening identity survives when the widening actually distinguishes it', () => {
    fc.assert(fc.property(
      fc.array(dataSourceArb, { minLength: 1, maxLength: 4 }),
      (dataSources) => {
        // Excludes a platform that also has a pass-through descriptor in this same array: that
        // descriptor legitimately resolves to the platform alone under today's correct code too,
        // so the platform-alone row surviving would be that descriptor's doing, not a defect.
        // (Found by this property itself: GOOGLE_FIT/AUTOMATICALLY_RECORDED alongside
        // GOOGLE_FIT/MANUAL failed here before this exclusion existed, correctly, for the wrong
        // reason.)
        const passesThroughPlatforms = new Set(dataSources.filter(passesThrough).map((ds) => ds.platform))
        const distinguishedPlatforms = new Set(
          dataSources.filter(widensThis).map((ds) => ds.platform)
            .filter((platform) => !passesThroughPlatforms.has(platform)),
        )
        // Skips a generated case where nothing here needed the widening to begin with; roughly
        // half of generated arrays have at least one such payload, so this costs little.
        fc.pre(distinguishedPlatforms.size > 0)

        lab.reset({ dataSources })
        for (const platform of distinguishedPlatforms) {
          // The pre-widening externalId for a no-device payload was the platform alone: "who"
          // came from the device name only, and a payload with no device had no "who".
          const oldId = idFor(lab.personId, platform)
          lab.db.insert(sources).values({
            id: oldId, personId: lab.personId, externalId: platform,
            displayName: platform, kind: 'app', createdAtMs: 1,
          }).run()
          // A sample from before the widening, the way a real instance that predates the change
          // actually looks. runRebuild's own bulk delete clears this regardless of which
          // describe() is running; it is here for fixture realism, not because the assertion
          // below depends on it surviving that delete.
          insertSample(lab.db, {
            personId: lab.personId, sourceId: oldId, metric: 'heart_rate', utcMs: 0,
          })
        }

        runRebuild({ ...lab.deps, nowMs: 1, force: true })

        const survivingIds = new Set(
          lab.db.select().from(sources).where(eq(sources.personId, lab.personId)).all()
            .map((r) => r.id),
        )
        for (const platform of distinguishedPlatforms) {
          expect(survivingIds.has(idFor(lab.personId, platform))).toBe(false)
        }
      },
    ), { numRuns: 50 })
  })
})

describe('describe() distinguishes what predates it collapsed', () => {
  // The reason the widening exists at all: before it, a scale app and a food diary reporting
  // through the same platform with no device between them became one source nobody could choose
  // between. These two properties characterise the widening by that behaviour rather than by
  // restating its formula, so reverting it fails these even though nothing here imports
  // describe() or names its internals.
  test('two apps on the same platform become two sources when they differ only in package name', () => {
    fc.assert(fc.property(
      fc.constantFrom('FITBIT', 'HEALTH_CONNECT', 'GOOGLE_FIT'),
      (platform) => {
        lab.reset({
          dataSources: [
            { platform, recordingMethod: 'PASSIVELY_MEASURED', application: { packageName: 'com.a.app' } },
            { platform, recordingMethod: 'PASSIVELY_MEASURED', application: { packageName: 'com.b.app' } },
          ],
        })

        runRebuild({ ...lab.deps, nowMs: 1, force: true })

        const rows = lab.db.select().from(sources).where(eq(sources.personId, lab.personId)).all()
        expect(new Set(rows.map((r) => r.externalId)).size).toBe(2)
      },
    ), { numRuns: 50 })
  })

  test('a manual reading and an automatic one from the same app become two sources', () => {
    fc.assert(fc.property(
      fc.constantFrom('FITBIT', 'HEALTH_CONNECT', 'GOOGLE_FIT'),
      fc.constantFrom('com.a.app', 'com.b.app'),
      (platform, packageName) => {
        lab.reset({
          dataSources: [
            { platform, application: { packageName }, recordingMethod: 'MANUAL' },
            { platform, application: { packageName }, recordingMethod: 'AUTOMATICALLY_RECORDED' },
          ],
        })

        runRebuild({ ...lab.deps, nowMs: 1, force: true })

        const rows = lab.db.select().from(sources).where(eq(sources.personId, lab.personId)).all()
        expect(new Set(rows.map((r) => r.externalId)).size).toBe(2)
      },
    ), { numRuns: 50 })
  })
})

describe('a source a rebuild drops takes its name with it', () => {
  let h: Rebuildable
  afterEach(() => { h.cleanup() })

  test('deletes the alias and reports how many went, but leaves a surviving source\'s alias alone', () => {
    // A source with an alias and no rows referencing it: exactly what a widened describe() leaves
    // behind, and what dropUnreferencedSources exists to clean up. Beside it, the source
    // seedRebuildable's own archive replays onto: its externalId and hence its id are exactly
    // what SourceRegistry.resolve derives for the default FITBIT/PASSIVELY_MEASURED descriptor
    // (packages/core/src/store/sources.ts), so pre-seeding this row under that id makes replay
    // reuse it (onConflictDoNothing on [personId, externalId]) rather than mint a fresh one, and
    // the heart-rate samples it replays reference it, so it survives. Its alias is here to catch a
    // delete widened from `inArray(sourceId, stale)` to just `personId`: that would still delete
    // exactly one alias overall (there is only one to find, since the widened delete does not
    // distinguish stale from surviving) and still leave the assertions below unable to tell the
    // widened delete from the correct one, unless what remains is checked by identity, not count.
    h = seedRebuildable()
    const survivingId = idFor(h.personId, 'FITBIT')
    h.db.insert(sources).values([
      { id: 'stale', personId: h.personId, externalId: 'OLD:phone', displayName: 'phone', kind: 'app', createdAtMs: 0 },
      { id: survivingId, personId: h.personId, externalId: 'FITBIT', displayName: 'FITBIT', kind: 'app', createdAtMs: 0 },
    ]).run()
    const aliases = new SourceAliasStore(h.db)
    aliases.put({ personId: h.personId, sourceId: 'stale', alias: 'Old phone', nowMs: 0 })
    aliases.put({ personId: h.personId, sourceId: survivingId, alias: 'My Fitbit', nowMs: 0 })

    const report = runRebuild({ ...h.deps, nowMs: 1, force: true })

    expect(report.people[0]!.sourcesRemoved).toBe(1)
    expect(report.people[0]!.aliasesRemoved).toBe(1)
    const remaining = h.db.select().from(sourceAliases).where(eq(sourceAliases.personId, h.personId)).all()
    expect(remaining.map((r) => ({ sourceId: r.sourceId, alias: r.alias })))
      .toEqual([{ sourceId: survivingId, alias: 'My Fitbit' }])
  })

  test('reports zero when the dropped sources had no names', () => {
    h = seedRebuildable()
    h.db.insert(sources).values([
      { id: 'stale', personId: h.personId, externalId: 'OLD:phone', displayName: 'phone', kind: 'app', createdAtMs: 0 },
    ]).run()

    const report = runRebuild({ ...h.deps, nowMs: 1, force: true })

    expect(report.people[0]!.sourcesRemoved).toBe(1)
    expect(report.people[0]!.aliasesRemoved).toBe(0)
  })

  // A choice about a source that no longer exists has nothing to apply to, and the foreign key
  // would refuse the source's delete above while it stayed. Unlike aliases, there is no count to
  // report: a lost choice falls back to a sensible default, so there is nothing for an operator
  // to redo.
  test('drops a visibility choice along with the source it names', () => {
    h = seedRebuildable()
    h.db.insert(sources).values([
      { id: 'stale', personId: h.personId, externalId: 'OLD:phone', displayName: 'phone', kind: 'app', createdAtMs: 0 },
    ]).run()
    const visibility = new SourceVisibilityStore(h.db)
    visibility.put({ personId: h.personId, sourceId: 'stale', visible: false, nowMs: 0 })

    const report = runRebuild({ ...h.deps, nowMs: 1, force: true })

    expect(report.people[0]!.sourcesRemoved).toBe(1)
    expect(visibility.list(h.personId).has('stale')).toBe(false)
  })
})
