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
    expect(heartRate?.horizonDays).toBe(90)
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
    expect(status.backfill.find((s) => s.dataType === 'heart-rate')?.horizonDays).toBe(90)
    expect(status.backfill.find((s) => s.dataType === 'weight')?.horizonDays).toBe(1825)
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
    // The real sprintDays and real batch size: the sprint needs to actually finish (see the
    // previous test's comment) before this can observe the trickle that follows it.
    harness = await withServer({ google: 'ok', sprintDays: 90, backfillBatchDays: 14 })
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
    // The real sprintDays: the regression this guards was a sprint running to completion under
    // a closing database, and that risk scales with how deep the sprint actually goes.
    harness = await withServer({ google: 'ok', sprintDays: 90 })
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
    // The real sprintDays: MAX_SPRINT_PASSES is what has to end this, and its margin is sized
    // against the real 90, not a harness default that would make the guard look tighter than
    // it actually is in production.
    harness = await withServer({ google: 'list_fails', sprintDays: 90 })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('setup')
    expect(harness.app.haelan.runner.status().running).toBe(false)
  })

  it('does not let one broken type block a healthy type from advancing past the sprint floor', async () => {
    // LIST_FAILS_TYPE (body-fat) never advances and is never marked complete, so #sprintPending
    // stays true forever - the regression this guards is that run() used to return right after
    // the sprint loop whenever that was still true, so the trickle never ran and weight, a
    // perfectly healthy daily type, stayed pinned at the sprint floor right alongside the type
    // that was actually broken, on every run from then on.
    harness = await withServer({ google: 'list_fails', sprintDays: 90, backfillBatchDays: 14 })
    await harness.connectPerson()
    const sprintFloor = harness.clock.nowMs - 90 * 86_400_000

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
