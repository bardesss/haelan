import { describe, it, expect, afterEach } from 'vitest'
import { LIST_FAILS_TYPE, withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

describe('the sync runner', () => {
  it('refuses a second run while one is in flight and says so rather than queueing', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const runner = harness.app.haelan.runner
    const first = runner.trigger('manual')
    const second = await runner.trigger('manual')
    expect(second).toMatchObject({ started: false, reason: 'already_running' })
    await first
  })

  it('reports itself idle once the run finishes', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('manual')
    expect(harness.app.haelan.runner.status().running).toBe(false)
    expect(harness.app.haelan.runner.status().lastFinishedAtMs).toBe(harness.clock.nowMs)
  })

  it('runs nothing for a person with no credential rather than throwing', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.completeSetup()
    // completeSetup stores the client but no refresh token, which is the state an instance is
    // in between the console step and consent. A scheduler tick here must not crash the server.
    const outcome = await harness.app.haelan.runner.trigger('scheduled')
    expect(outcome.started).toBe(true)
    expect(harness.app.haelan.runner.status().running).toBe(false)
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
    const summary = harness.app.haelan.runner.status().backfill
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
    const status = harness.app.haelan.runner.status()
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
    harness = await withServer({ google: 'ok', sprintDays: 90, backfillBatchDays: 14 })
    await harness.connectPerson()
    const stores = harness.app.haelan.stores
    const oldFloorMs = harness.clock.nowMs - 90 * 86_400_000
    stores.syncState.setBackfillCursor({ personId: 'p1', dataType: 'heart-rate', cursorMs: oldFloorMs, nowMs: harness.clock.nowMs })
    stores.syncState.markBackfillComplete({ personId: 'p1', dataType: 'heart-rate', nowMs: harness.clock.nowMs })

    await harness.app.haelan.runner.trigger('scheduled')

    // Walked strictly past the old floor rather than sitting there silently complete at 90 days
    // forever, which is what a raised cap would otherwise do nothing for.
    const heartRate = harness.app.haelan.runner.status().backfill.find((s) => s.dataType === 'heart-rate')
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
    while (runner.status().running) await new Promise((resolve) => setImmediate(resolve))
  })

  it('fills the sprint window in one run rather than one batch an hour', async () => {
    // The real sprintDays (90) and the real batch size (14, runBackfill's own default), not the
    // harness's speed-picked defaults, so this asserts against production's own numbers: at 14
    // a single-batch run would leave every cursor fourteen days back, and MAX_SPRINT_PASSES (40)
    // comfortably covers the ceil(90 / 14) = 7 passes a real sprint needs. Reaching the sprint
    // depth proves the run looped rather than yielded.
    harness = await withServer({ google: 'ok', sprintDays: 90, backfillBatchDays: 14 })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    const status = harness.app.haelan.runner.status()
    const sprintFloor = harness.clock.nowMs - 90 * 86_400_000
    for (const row of status.backfill) {
      expect(row.complete || (row.cursorMs !== null && row.cursorMs <= sprintFloor)).toBe(true)
    }
  })

  it('stops at the sprint window and leaves the deep history to later runs', async () => {
    // The real sprintDays and real batch size: at the harness's default batch of 1, forty
    // passes only reaches 40 days and the sprint-floor skip this test is actually about never
    // fires - the test would pass because MAX_SPRINT_PASSES ran out, not because the cap held.
    harness = await withServer({ google: 'ok', sprintDays: 90, backfillBatchDays: 14 })
    await harness.connectPerson()
    harness.app.haelan.stores.settings.putBackfillHorizon(1825, harness.clock.nowMs)
    await harness.app.haelan.runner.trigger('setup')
    const weight = harness.app.haelan.runner.status().backfill.find((s) => s.dataType === 'weight')
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
    harness = await withServer({ google: 'ok', sprintDays: 28, backfillBatchDays: 14 })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    const before = harness.app.haelan.runner.status().backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    await harness.app.haelan.runner.trigger('scheduled')
    const after = harness.app.haelan.runner.status().backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    // One batch of fourteen days (backfillBatchDays passed above), not another sprint.
    expect(before - after).toBeLessThanOrEqual(16 * 86_400_000)
    expect(after).toBeLessThan(before)
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
    expect(runner.status().running).toBe(false)
    // The regression this exists for: a sprint that ran to completion under a closing database
    // surfaced as "the database connection is not open" from somewhere unrelated. stop() lands
    // before the first await inside runSync resolves, and runSync writes no backfill cursors of
    // its own, so #aborted is already true by the time run() would otherwise enter the sprint
    // loop - no cursor at all is what proves the sprint never took a single step, not merely
    // that weight in particular fell short of some deep horizon it was never asked to reach here.
    const status = runner.status()
    expect(status.backfill.every((row) => row.cursorMs === null)).toBe(true)
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
    expect(runner.status().running).toBe(false)
  })

  it('does not spin forever on a type that fails every window', async () => {
    // Not about the number 90 either: this proves the sprint terminates when a type never
    // converges, not that it terminates specifically at the production depth. The harness
    // default reaches that outcome in a handful of passes instead of forty.
    harness = await withServer({ google: 'list_fails' })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    expect(harness.app.haelan.runner.status().running).toBe(false)
  })

  it('does not let one broken type block a healthy type from advancing past the sprint floor', async () => {
    // This is about the starvation, not about the number 90 - the mechanism (a permanently
    // stuck type keeping #sprintPending true forever, and the trickle running anyway) does not
    // depend on how deep the sprint's own floor is. A small sprintDays that still converges in
    // a couple of passes (ceil(28 / 14) = 2, plus one more pass for the stuck type alone to
    // confirm nothing else is left) proves the same fix far cheaper than walking to 90.
    harness = await withServer({ google: 'list_fails', sprintDays: 28, backfillBatchDays: 14 })
    await harness.connectPerson()
    const sprintFloor = harness.clock.nowMs - 28 * 86_400_000

    await harness.app.haelan.runner.trigger('setup')
    const afterFirst = harness.app.haelan.runner.status().backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    expect(afterFirst).toBeLessThanOrEqual(sprintFloor)

    await harness.app.haelan.runner.trigger('scheduled')
    const afterSecond = harness.app.haelan.runner.status().backfill
      .find((s) => s.dataType === 'weight')!.cursorMs!
    // Strictly deeper, not just "still at the floor": the second run's trickle pass had to do
    // real work, which only happens if run() reached it despite #sprintPending staying true.
    expect(afterSecond).toBeLessThan(afterFirst)

    const brokenType = harness.app.haelan.runner.status().backfill
      .find((s) => s.dataType === LIST_FAILS_TYPE)
    expect(brokenType?.complete).toBe(false)
  })
})
