import { randomBytes } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { CredentialStore, DATA_TYPES, DERIVATION_VERSION, MAPPING_VERSION, SCOPES, supports } from '@haelan/core'
import { LIST_FAILS_TYPE, withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { MAX_SPRINT_PASSES } from '../src/sync/runner.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// One budget for every test in this file, applied on the describe. There is no ordinary test
// here: each one boots a real Fastify server, creates an account through argon2 (deliberately
// expensive), and most then await a sync that walks every listable data type for every connected
// person. The global 20s testTimeout is sized for the six hundred tests that do none of that.
//
// 180s is sized for contention rather than solo cost, because solo cost understates a full run by
// up to 3x on this hardware: "does not let one broken type block a healthy type" measured 21.6s
// alone and still exceeded 60s in a full suite run.
//
// It is now generously above what the file needs, which is where a hang-detector belongs. Two
// rounds of narrowing took the file from 229s to 85s and then to 32s alone, and the heaviest test
// in it from 47s to 39.5s to 5.4s, so the margin went from uncomfortable to ample without the
// number moving. Tightening it to match would trade a real safety margin for nothing, and would
// hide a future cost regression behind a budget that had been pulled down to meet it.
//
// It got here by two wrong answers, both worth keeping so nobody retries them. First, per-test
// annotations on the four obvious offenders - which missed a fifth test that measures 75ms alone,
// timed out at 20s on a CI runner and turned master red, because what those tests share is the
// harness rather than the sprint. Then a two-tier scheme, a 60s floor with 180s for the real
// sprint tests - which failed on the one test whose 2.8x margin was not the 3x it needed.
//
// The cost doubled when it was last measured for a different reason: a run walks every listable
// data type, and the catalogue went from 20 types to 42. The budgets predating that were all
// sized against half the work.
//
// This is a hang-detector, not a performance assertion, and a performance assertion is exactly
// what it must not become on hardware this suite does not choose. The global 20s still guards the
// other 227 files, where 20s genuinely means "this is hung".
//
// The real fix was cheaper tests rather than a wider budget, and it has since been done: four of
// these tests now pass `dataTypes` to the harness and walk a handful of types instead of all 39
// listable ones, because their subject is the sprint loop and not the catalogue.
//
// "fills the sprint window" was the one held back, on the argument that it asserts over every row
// of status.backfill and so breadth was its subject rather than its cost. That was half right and
// it cost us a red master: at 39 types it walked 4,368 backfill windows, 39.5s alone here and
// 509s on a contended CI runner, past this very budget. Breadth is its subject; the whole
// catalogue was never what its subject required, and it now walks six types chosen so the defect
// it exists for still fails it. The comment on the test says which six and why that number.
//
// Where the per-window cost actually is, measured rather than assumed, since the last two
// attempts at this file both guessed: 59% of that run was Intl.DateTimeFormat construction inside
// startOfLocalDay (packages/core/src/sync/windows.ts), which builds a formatter per probe and
// probes ~30 times per window. gzip was 1.8% and every SQLite call together about 15%. Memoising
// that formatter per zone cuts the same run 4.6x, and is a production win rather than a test one;
// it is not what fixed this file, and it is still worth doing.
const SPRINT_BUDGET_MS = 180_000

// What "fills the sprint window in one run rather than one batch an hour" walks, and the two
// production numbers it walks them with. Named rather than written as literals at the call
// because that test guards itself with arithmetic over them, and a guard reading numbers the
// harness is not actually given would be a guard over nothing. See the comment there for why
// six types, and which six.
const SPRINT_DAYS = 90
const SPRINT_BATCH_DAYS = 14
const PASSES_PER_TYPE = Math.ceil(SPRINT_DAYS / SPRINT_BATCH_DAYS)
const SPRINT_TYPES = [
  // Intraday, so their horizon resolves to the 365 day cap.
  'heart-rate', 'steps',
  // Daily, so their horizon follows the operator's 730 day default - the other side of the
  // per-type cap skip in #backfillPass.
  'weight', 'blood-glucose',
  // The other two write targets, which cost nothing extra to include here.
  'sleep', 'moods',
]

describe('the sync runner', { timeout: SPRINT_BUDGET_MS }, () => {
  it('refuses a second run while one is in flight and says so rather than queueing', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const runner = harness.app.haelan.runner
    const first = runner.trigger('manual')
    const second = await runner.trigger('manual')
    expect(second).toMatchObject({ started: false, reason: 'already_running' })
    await first
  })

  it('skips a person whose derived data is not at the current versions', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    // A person the boot rebuild could not finish: connected, and carrying derived rows built by
    // something older. A failed rebuild leaves the columns null rather than at 0, but the gate
    // reads both the same way and peopleNeedingRebuild's own tests pin that; what this needs is
    // a state reachable through a public store method rather than a hand written UPDATE.
    harness.app.haelan.stores.people.stampBuiltVersions({
      id: 'p1', mappingVersion: 0, derivationVersion: 0,
    })

    await harness.app.haelan.runner.trigger('scheduled')

    // Nothing was fetched for them at all. This is the invariant the version stamp exists for:
    // a sync appending rows derived at the current version beside rows derived at an older one
    // leaves a person whose tiers disagree, which is exactly what a rebuild is meant to prevent.
    expect(harness.app.haelan.stores.syncState.get('p1', 'heart-rate')).toBeNull()
  })

  // The skip above stops the fetching. It has to stop the draining too, or the quarantine leaks:
  // a day already queued before the rebuild failed would be derived at the current derivation
  // version on top of tier 2 built by an older mapper, which is the one state the version stamp
  // exists to make impossible. Two people, because with only a quarantined one the run returns
  // before it drains anything and this would pass without draining being gated at all.
  it('does not derive a quarantined person, while still draining everybody else', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const { stores, instance } = harness.app.haelan
    stores.people.create({
      id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', nowMs: harness.clock.nowMs,
    })
    instance.credentials.putRefreshToken({
      personId: 'p2', refreshToken: 'stub-refresh-token', scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })
    stores.people.stampBuiltVersions({ id: 'p1', mappingVersion: 0, derivationVersion: 0 })
    instance.deriveQueue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })
    instance.deriveQueue.markDirty({ personId: 'p2', localDate: '2026-08-22', nowMs: 2 })

    await harness.app.haelan.runner.trigger('scheduled')

    expect(instance.deriveQueue.claim(10)).toEqual([
      { personId: 'p1', localDate: '2026-08-22' },
    ])
  })

  it('says a person is being skipped once rather than on every tick', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    harness.app.haelan.stores.people.stampBuiltVersions({
      id: 'p1', mappingVersion: 0, derivationVersion: 0,
    })
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '))
    })

    try {
      // Hourly in production. A line per tick is how a real reason to look becomes noise nobody
      // reads by the second day, so it is said when the state is entered and not again.
      await harness.app.haelan.runner.trigger('scheduled')
      await harness.app.haelan.runner.trigger('scheduled')
      await harness.app.haelan.runner.trigger('scheduled')
    } finally {
      spy.mockRestore()
    }

    expect(lines.filter((l) => l.includes('p1'))).toHaveLength(1)
  })

  it('syncs a person again once their rebuild has brought them up to date', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const stores = harness.app.haelan.stores
    stores.people.stampBuiltVersions({ id: 'p1', mappingVersion: 0, derivationVersion: 0 })
    await harness.app.haelan.runner.trigger('scheduled')
    expect(stores.syncState.get('p1', 'heart-rate')).toBeNull()

    // What a later boot's rebuild leaves behind. The skip has to be a state the runner reads
    // every run, not a decision it made once and cached, or a person rescued by a fixed mapper
    // would stay quarantined until the process was restarted a second time.
    stores.people.stampBuiltVersions({
      id: 'p1', mappingVersion: MAPPING_VERSION, derivationVersion: DERIVATION_VERSION,
    })
    await harness.app.haelan.runner.trigger('scheduled')

    expect(stores.syncState.get('p1', 'heart-rate')).not.toBeNull()
  })

  it('reports itself idle once the run finishes', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('manual')
    expect(harness.app.haelan.runner.runState().running).toBe(false)
    expect(harness.app.haelan.runner.runState().lastFinishedAtMs).toBe(harness.clock.nowMs)
  })

  it('runs nothing for a person with no credential rather than throwing', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.completeSetup()
    // completeSetup stores the client but no refresh token, which is the state an instance is
    // in between the console step and consent. A scheduler tick here must not crash the server.
    const outcome = await harness.app.haelan.runner.trigger('scheduled')
    expect(outcome.started).toBe(true)
    expect(harness.app.haelan.runner.runState().running).toBe(false)
  })

  it('delivers progress events to a subscriber and stops after unsubscribe', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const seen: string[] = []
    const unsubscribe = harness.app.haelan.runner.subscribe((event) => seen.push(event.kind))
    await harness.app.haelan.runner.trigger('manual')
    expect(seen).toContain('run_finished')
    unsubscribe()
    const before = seen.length
    await harness.app.haelan.runner.trigger('manual')
    expect(seen).toHaveLength(before)
  })

  it('survives a subscriber that throws, because a broken SSE client is not a data loss event', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    harness.app.haelan.runner.subscribe(() => { throw new Error('client went away') })
    const outcome = await harness.app.haelan.runner.trigger('manual')
    expect(outcome.started).toBe(true)
  })

  it('reports backfill progress per data type, including the horizon it is walking to', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('manual')
    const summary = harness.app.haelan.runner.status('p1').backfill
    expect(summary.length).toBeGreaterThan(0)
    const heartRate = summary.find((s) => s.dataType === 'heart-rate')
    expect(heartRate?.horizonDays).toBe(365)
    // The walk actually moved: a cursor still null after a run would mean the backfill was
    // scheduled and never took a step.
    expect(heartRate?.cursorMs).not.toBeNull()
  })

  it('reports the resolved horizon per type and the operator choice behind it', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    harness.app.haelan.stores.settings.putBackfillHorizon(1825, harness.clock.nowMs)
    await harness.app.haelan.runner.trigger('manual')
    const status = harness.app.haelan.runner.status('p1')
    expect(status.userHorizonDays).toBe(1825)
    // Intraday stays capped however deep the operator asked to go; daily follows them.
    expect(status.backfill.find((s) => s.dataType === 'heart-rate')?.horizonDays).toBe(365)
    expect(status.backfill.find((s) => s.dataType === 'weight')?.horizonDays).toBe(1825)
  })

  it('re-opens an intraday type completed at an old, shallower horizon and walks it further', async () => {
    // The regression this exists for: raising INTRADAY_HORIZON_DAYS (90 to 365 today, but the
    // point is general) does nothing for an instance where heart-rate already finished walking
    // to the old cap, unless something clears the stale completion mark - runBackfill returns
    // immediately once backfillCompleteAtMs is set, and nothing else ever clears it. Simulates
    // that pre-existing state directly, the state a real instance would already be in, rather
    // than running a real 90 day backfill first just to arrive there.
    //
    // Harness defaults, not the production sprint numbers its neighbours below use: nothing here
    // turns on sprint depth or batch size. What is asserted is that the stale mark gets cleared
    // and the cursor moves past the old floor at all, and #backfillPass clears it on any pass.
    // This test carried sprintDays 90 / batch 14 for no reason it needed, which cost it 26.8s
    // under load against a 20s budget - the flake. Verified by mutation rather than by argument:
    // with clearBackfillComplete disabled it still fails, on the cursor sitting exactly on the
    // old floor.
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const stores = harness.app.haelan.stores
    const oldFloorMs = harness.clock.nowMs - 90 * 86_400_000
    stores.syncState.setBackfillCursor({ personId: 'p1', dataType: 'heart-rate', cursorMs: oldFloorMs, nowMs: harness.clock.nowMs })
    stores.syncState.markBackfillComplete({ personId: 'p1', dataType: 'heart-rate', nowMs: harness.clock.nowMs })

    await harness.app.haelan.runner.trigger('scheduled')

    // Walked strictly past the old floor rather than sitting there silently complete at 90 days
    // forever, which is what a raised cap would otherwise do nothing for.
    const heartRate = harness.app.haelan.runner.status('p1').backfill.find((s) => s.dataType === 'heart-rate')
    expect(heartRate?.cursorMs).toBeLessThan(oldFloorMs)
  })

  it('takes the mutex synchronously, so a second caller cannot slip in before the first awaits', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const runner = harness.app.haelan.runner
    const first = runner.tryStart('manual')
    const second = runner.tryStart('manual')
    expect(first).toEqual({ started: true })
    expect(second).toMatchObject({ started: false, reason: 'already_running' })
    // tryStart leaves the run going, so let it finish before the harness closes the database
    // out from under it.
    while (runner.runState().running) await new Promise((resolve) => setImmediate(resolve))
  })

  it('fills the sprint window in one run rather than one batch an hour', async () => {
    // The real sprintDays (90) and the real batch size (14, runBackfill's own default), not the
    // harness's speed-picked defaults, so this asserts against production's own numbers: at 14
    // a single-batch run would leave every cursor fourteen days back, and MAX_SPRINT_PASSES (40)
    // comfortably covers the ceil(90 / 14) = 7 passes a real sprint needs. Reaching the sprint
    // depth proves the run looped rather than yielded.
    //
    // Six types rather than all thirty-nine listable ones, which is a change of position from
    // what stood here: this used to keep the whole catalogue on the argument that breadth was
    // its subject. Breadth is its subject, but the whole catalogue was never what the subject
    // required - 39 types at this depth is 4,368 backfill windows, measured at 39.5s alone and
    // 509s on a contended CI runner, where it blew the file's 180s budget and turned master red.
    // What the assertion below actually needs is more than one row, so that a sprint reaching
    // the floor for the first type it walks and leaving the rest short fails here.
    //
    // Six and not two, because the weaker version of that defect is a pass that advances one
    // type per pass instead of every type, and it hides at small breadth: a sprint needs
    // ceil(90 / 14) = 7 passes per type, so five types converge inside MAX_SPRINT_PASSES anyway
    // and six cannot. The expect below reads that constant rather than trusting this paragraph,
    // so raising MAX_SPRINT_PASSES fails here instead of silently buying the coverage back out.
    // Which six is not arbitrary either: the sprint cap is skipped per type against the type's
    // resolved horizon, so both resolutions are present (intraday's 365 day cap, and the 730 day
    // operator default the daily types follow), and all three write targets come with them.
    //
    // That every listable type is reported and walked at all is a different claim, and it is
    // asserted where it costs nothing: "leaves every other catalogue type present, including
    // ones nobody has heard of" and "is not walked by the backfill pass during a sync run", both
    // in sync-exclusions.test.ts at harness defaults.
    expect(SPRINT_TYPES.length * PASSES_PER_TYPE,
      'a pass advancing one type instead of all of them would still converge').toBeGreaterThan(MAX_SPRINT_PASSES)
    harness = await withServer({
      google: 'ok', sprintDays: SPRINT_DAYS, backfillBatchDays: SPRINT_BATCH_DAYS,
      dataTypes: SPRINT_TYPES,
    })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    const status = harness.app.haelan.runner.status('p1')
    // The loop below is vacuously true over an empty array, and a mistyped id in SPRINT_TYPES
    // would produce exactly that - a green test walking nothing at all.
    expect(status.backfill).toHaveLength(SPRINT_TYPES.length)
    const sprintFloor = harness.clock.nowMs - SPRINT_DAYS * 86_400_000
    for (const row of status.backfill) {
      expect(row.complete || (row.cursorMs !== null && row.cursorMs <= sprintFloor)).toBe(true)
    }
  })

  it('stops at the sprint window and leaves the deep history to later runs', async () => {
    // The real sprintDays and real batch size: at the harness's default batch of 1, forty
    // passes only reaches 40 days and the sprint-floor skip this test is actually about never
    // fires - the test would pass because MAX_SPRINT_PASSES ran out, not because the cap held.
    //
    // One type, where its neighbour above walks six: every assertion here reads 'weight' and
    // nothing else, so any other type only adds cost. The breadth case is that neighbour's job.
    harness = await withServer({
      google: 'ok', sprintDays: 90, backfillBatchDays: 14, dataTypes: ['weight'],
    })
    await harness.connectPerson()
    harness.app.haelan.stores.settings.putBackfillHorizon(1825, harness.clock.nowMs)
    await harness.app.haelan.runner.trigger('setup')
    const weight = harness.app.haelan.runner.status('p1').backfill.find((s) => s.dataType === 'weight')
    // Daily types were asked for five years; the sprint must not have walked them there.
    expect(weight?.complete).toBe(false)
    expect(weight?.cursorMs).toBeGreaterThan(harness.clock.nowMs - 1825 * 86_400_000)
  })

  it('reverts to one batch per type once the sprint window is filled', async () => {
    // This test is about the revert, not about the number 90 - it only needs the sprint to
    // finish so the trickle that follows is observable. A small sprintDays that converges in
    // two passes (ceil(28 / 14) = 2) proves the same revert far cheaper than walking to the
    // real 90; the production number is asserted where it belongs, in "stops at the sprint
    // window and leaves the deep history to later runs" below.
    // One type. The subject is the revert from a sprint to a single batch, which 'weight' - the
    // only type the assertions below read - demonstrates as completely as forty-two would.
    harness = await withServer({
      google: 'ok', sprintDays: 28, backfillBatchDays: 14, dataTypes: ['weight'],
    })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    const before = harness.app.haelan.runner.status('p1').backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    await harness.app.haelan.runner.trigger('scheduled')
    const after = harness.app.haelan.runner.status('p1').backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    // One batch of fourteen days (backfillBatchDays passed above), not another sprint.
    expect(before - after).toBeLessThanOrEqual(16 * 86_400_000)
    expect(after).toBeLessThan(before)
    // REAL_SPRINT despite the small sprintDays above, which reads like a contradiction and is not.
    // The sprint here is cheap; the two full runs either side of it are not, because a run walks
    // every listable data type and the catalogue went from 20 types to 42. Measured at 47.0s alone
    // against the 60s floor - a 1.28x margin, the thinnest in the file and the next one that would
    // have failed on a slower runner.
  })

  it('abandons a sprint promptly when asked to stop, so shutdown does not wait for it', async () => {
    // Not about the number 90: stop() lands before runSync's first await resolves (see the
    // assertion below), so #aborted is already true before run() would even check
    // #sprintPending - no backfill pass happens regardless of how deep a sprint would have
    // gone. The harness default is enough to prove that; production's real depth is asserted
    // in "stops at the sprint window and leaves the deep history to later runs".
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const runner = harness.app.haelan.runner
    runner.tryStart('setup')
    runner.stop()
    await runner.settle()
    expect(runner.runState().running).toBe(false)
    // The regression this exists for: a sprint that ran to completion under a closing database
    // surfaced as "the database connection is not open" from somewhere unrelated. stop() lands
    // before the first await inside runSync resolves, and runSync writes no backfill cursors of
    // its own, so #aborted is already true by the time run() would otherwise enter the sprint
    // loop - no cursor at all is what proves the sprint never took a single step, not merely
    // that weight in particular fell short of some deep horizon it was never asked to reach here.
    const status = runner.status('p1')
    expect(status.backfill.every((row) => row.cursorMs === null)).toBe(true)

    // The cursors above prove the sprint never took a step, but the trailing sync runs before the
    // sprint and writes no cursor of its own, so on their own they say nothing about it. Its
    // evidence is the high water marks. run() passes shouldStop into runSync; without that the
    // trailing sync walks every listable type to completion while settle() waits, leaving a mark
    // on each of them. At most one is what stopping between jobs looks like.
    const stores = harness.app.haelan.stores
    const marked = stores.people.list().flatMap((person) =>
      DATA_TYPES.filter((type) => supports(type, 'list'))
        .filter((type) => stores.syncState.get(person.id, type.id)?.highWaterMs != null))
    expect(marked.length, 'the trailing sync kept walking after stop()').toBeLessThanOrEqual(1)
  })

  it('refuses to start once stopped, so a request racing shutdown cannot restart the sprint settle() is waiting out', async () => {
    // shutdown() calls stop() then awaits settle() while the HTTP server is still accepting
    // requests (apps/server/src/index.ts); routes/sync.ts's tryStart('manual') and
    // routes/oauth.ts's tryStart('setup') are both entrances a request could reach in that
    // window. If stop() only cleared #aborted for the run already in flight, the aborted run
    // finishing would make trigger() reset #aborted back to false and let a new one start,
    // and settle()'s while loop would then wait out that new run's whole sprint instead of
    // returning. Both tryStart and trigger have to refuse, since the scheduler calls trigger
    // directly.
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const runner = harness.app.haelan.runner
    runner.stop()
    expect(runner.tryStart('manual')).toMatchObject({ started: false, reason: 'shutting_down' })
    expect(await runner.trigger('manual')).toMatchObject({ started: false, reason: 'shutting_down' })
    expect(runner.runState().running).toBe(false)
  })

  it('does not spin forever on a type that fails every window', async () => {
    // Not about the number 90 either: this proves the sprint terminates when a type never
    // converges, not that it terminates specifically at the production depth. The harness
    // default reaches that outcome in a handful of passes instead of forty.
    harness = await withServer({ google: 'list_fails' })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    expect(harness.app.haelan.runner.runState().running).toBe(false)
  })

  it('does not let one broken type block a healthy type from advancing past the sprint floor', async () => {
    // This is about the starvation, not about the number 90 - the mechanism (a permanently
    // stuck type keeping #sprintPending true forever, and the trickle running anyway) does not
    // depend on how deep the sprint's own floor is. A small sprintDays that still converges in
    // a couple of passes (ceil(28 / 14) = 2, plus one more pass for the stuck type alone to
    // confirm nothing else is left) proves the same fix far cheaper than walking to 90.
    // Two types, which is exactly what the assertions below name: the broken one and 'weight'
    // as the healthy one that must keep advancing past it. The other forty prove nothing here
    // and cost the whole difference.
    harness = await withServer({
      google: 'list_fails', sprintDays: 28, backfillBatchDays: 14,
      dataTypes: [LIST_FAILS_TYPE, 'weight'],
    })
    await harness.connectPerson()
    const sprintFloor = harness.clock.nowMs - 28 * 86_400_000

    await harness.app.haelan.runner.trigger('setup')
    const afterFirst = harness.app.haelan.runner.status('p1').backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    expect(afterFirst).toBeLessThanOrEqual(sprintFloor)

    await harness.app.haelan.runner.trigger('scheduled')
    const afterSecond = harness.app.haelan.runner.status('p1').backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    // Strictly deeper, not just "still at the floor": the second run's trickle pass had to do
    // real work, which only happens if run() reached it despite #sprintPending staying true.
    expect(afterSecond).toBeLessThan(afterFirst)

    const brokenType = harness.app.haelan.runner.status('p1').backfill
      .find((s) => s.dataType === LIST_FAILS_TYPE)
    expect(brokenType?.complete).toBe(false)
  })

  it('does not record a per type sync failure for a credential the instance key cannot decrypt, and does not spin the sprint chasing it', async () => {
    // The runner's own share of the five sites this state's commit widened outside its brief -
    // see credentials-unreadable-sync.test.ts (packages/core) for runJob, runBackfill and
    // runSync's rollup catch, which this test does not repeat. This one is #backfillPass's own:
    // the cursorAdvanced exclusion at the end of the sprint loop's per-type try. Built the way
    // maintenance-routes.test.ts's "connected: false, credentialsUnreadable: true" test builds
    // it - a second CredentialStore over the same database, sealing the row under a key this
    // process never held - rather than a stub that throws the error class by hand, so
    // credentials.ts's own decrypt failure is what drives the walk.
    //
    // One type, so a sprint pending forever on it is the only thing that can keep the loop
    // going. Without the exclusion, windowsFetched > 0 on every pass - the failing window still
    // counts as fetched - would read as progress, and the sprint would spend every one of
    // MAX_SPRINT_PASSES chasing a cursor that can never move, logging "sprint used all N passes
    // without converging", instead of the one pass it takes to notice nothing did.
    const dataTypeId = 'weight'
    harness = await withServer({
      google: 'ok', dataTypes: [dataTypeId], sprintDays: 90, backfillBatchDays: 14,
    })
    await harness.connectPerson()

    const { db } = harness.app.haelan.instance
    new CredentialStore(db, randomBytes(32)).putRefreshToken({
      personId: 'p1', refreshToken: 'sealed-under-a-key-this-process-does-not-have',
      scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '))
    })
    try {
      await harness.app.haelan.runner.trigger('manual')
    } finally {
      spy.mockRestore()
    }

    // Nothing in sync_state at all: neither the trailing sync nor either backfill pass ever
    // called recordFailure, recordSchemaDrift or recordSuccess for this person and type.
    expect(harness.app.haelan.stores.syncState.get('p1', dataTypeId)).toBeNull()
    expect(lines.some((l) => l.includes('sprint used all'))).toBe(false)
  })
})
