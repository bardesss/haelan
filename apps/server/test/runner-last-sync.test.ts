import { describe, it, expect, afterEach } from 'vitest'
import { body, dataTypeById, samplePoint } from '@haelan/core'
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

  it('counts the rows the backfill wrote, not only the trailing sync\'s', async () => {
    // run_finished is runSync's event, and runSync is only the trailing window: the sprint and
    // the trickle run after it, through runBackfill, and write rows run_finished never saw. When
    // the totals came from run_finished alone, a run whose only new data was history - the
    // normal case for a first sync's sprint - persisted rowsWritten 0 and the panel said
    // "Nothing new." The fetch below answers the trailing window empty and every window after
    // run_finished with one weight reading, so the only rows this run writes are the backfill's.
    harness = await withServer({ google: 'ok', dataTypes: ['weight'] })
    await harness.connectPerson()
    await harness.app.haelan.runner.settle()   // connectPerson's own setup run, out of the way

    const weight = dataTypeById('weight')!
    let backfilling = false
    const stubbed = harness.app.haelan.fetch
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (backfilling && String(input).includes('/dataPoints')) {
        return new Response(body([samplePoint({
          payloadKey: weight.payloadKey, valuePath: weight.valuePath, value: 70_000,
          physicalTime: '2026-01-20T08:00:00Z',
        })]), { status: 200 })
      }
      return stubbed(input, init)
    }) as typeof globalThis.fetch
    const runner = new SyncRunner({ ...harness.app.haelan, fetch })
    let trailingRows: number | null = null
    let backfillRows = 0
    runner.subscribe((event) => {
      if (event.kind === 'run_finished') { trailingRows = event.rowsWritten; backfilling = true }
      else if (event.kind === 'job_finished' && backfilling) backfillRows += event.rowsWritten
    })
    harness.clock.nowMs += 10 * 60_000   // past the manual cooldown the setup run left behind

    await runner.trigger('manual')

    expect(trailingRows).toBe(0)
    expect(backfillRows).toBeGreaterThan(0)
    expect(harness.app.haelan.stores.settings.lastSync()?.rowsWritten).toBe(backfillRows)
    expect(runner.runState().lastRowsWritten).toBe(backfillRows)
  })

  it('counts a type whose backfill failed, not only the trailing sync\'s failures', async () => {
    // The mirror of the rows case above: a type the trailing sync read fine and whose history
    // then failed to load finished a run that reported failed 0.
    harness = await withServer({ google: 'ok', dataTypes: ['weight'] })
    await harness.connectPerson()
    await harness.app.haelan.runner.settle()

    let backfilling = false
    const stubbed = harness.app.haelan.fetch
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (backfilling && String(input).includes('/dataPoints')) {
        return new Response(JSON.stringify({ error: 'history is broken' }), { status: 400 })
      }
      return stubbed(input, init)
    }) as typeof globalThis.fetch
    const runner = new SyncRunner({ ...harness.app.haelan, fetch })
    let trailingFailed: number | null = null
    runner.subscribe((event) => {
      if (event.kind === 'run_finished') { trailingFailed = event.failed; backfilling = true }
    })
    harness.clock.nowMs += 10 * 60_000

    await runner.trigger('manual')

    expect(trailingFailed).toBe(0)
    // One type, failing in every pass it is offered: counted once, as a job, not once per pass.
    expect(harness.app.haelan.stores.settings.lastSync()?.failed).toBe(1)
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
