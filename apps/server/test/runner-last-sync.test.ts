import { describe, it, expect, afterEach } from 'vitest'
import { SyncRunner } from '../src/sync/runner.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

describe('runner last sync', () => {
  it('persists the finished run, with the totals run_finished reported', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    await harness.app.haelan.runner.trigger('manual')
    const last = harness.app.haelan.stores.settings.lastSync()
    expect(last?.finishedAtMs).toBe(harness.clock.nowMs)
    expect(last?.failed).toBe(0)
    expect(typeof last?.rowsWritten).toBe('number')
  })

  it('reads the last finish from the database after a restart', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    harness.app.haelan.stores.settings.putLastSync({ finishedAtMs: 5_000, rowsWritten: 3, failed: 0 }, 5_000)
    const fresh = new SyncRunner(harness.app.haelan)   // a new runner, as after a restart
    expect(fresh.runState().lastFinishedAtMs).toBe(5_000)
    expect(fresh.runState().lastRowsWritten).toBe(3)
  })

  it('refuses a manual run inside the cooldown and says how long is left', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const now = harness.clock.nowMs
    harness.app.haelan.stores.settings.putLastSync({ finishedAtMs: now - 20_000, rowsWritten: 0, failed: 0 }, now)
    const outcome = harness.app.haelan.runner.tryStart('manual')
    expect(outcome).toEqual({ started: false, reason: 'cooldown', retryAfterMs: 40_000 })
  })

  it('lets a scheduled run through inside the cooldown', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const now = harness.clock.nowMs
    harness.app.haelan.stores.settings.putLastSync({ finishedAtMs: now - 20_000, rowsWritten: 0, failed: 0 }, now)
    expect(harness.app.haelan.runner.tryStart('scheduled').started).toBe(true)
    await harness.app.haelan.runner.settle()
  })
})
