import { describe, it, expect, afterEach } from 'vitest'
import { DATA_TYPES, SCOPES, supports } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const listableIds = DATA_TYPES.filter((t) => supports(t, 'list')).map((t) => t.id)

// weight, not floors: floors' only actions are rollUp/dailyRollUp/reconcile (see catalogue.ts),
// so it never passes the runner's own supports(type, 'list') guard and would sit outside every
// walk this task touches regardless of exclusion - a test built on it would pass without
// exercising #typesFor at all. weight takes the listable() defaults (actions: ['list']) and is
// otherwise unremarkable, which is what a type standing in for "an excluded one" should be.
const EXCLUDED_TYPE = 'weight'
const CONTROL_TYPE = 'steps'

describe('a person\'s excluded types', () => {
  it('are absent from the backfill status', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const stores = harness.app.haelan.stores
    const before = harness.app.haelan.runner.status('p1').backfill.map((row) => row.dataType)

    stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: [EXCLUDED_TYPE], nowMs: harness.clock.nowMs,
    })

    const after = harness.app.haelan.runner.status('p1').backfill.map((row) => row.dataType)
    expect(after).toEqual(before.filter((id) => id !== EXCLUDED_TYPE))
  })

  // The property the exclusion direction exists for. A type the catalogue gains tomorrow must be
  // on for everybody who already installed; an inclusion list would leave it off and silent.
  it('leaves every other catalogue type present, including ones nobody has heard of', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    harness.app.haelan.stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: [EXCLUDED_TYPE], nowMs: harness.clock.nowMs,
    })

    const after = harness.app.haelan.runner.status('p1').backfill.map((row) => row.dataType)
    expect(after).toEqual(listableIds.filter((id) => id !== EXCLUDED_TYPE))
  })

  // "Fetched" is asserted through the backfill cursor rather than through raw_payloads rows: the
  // trailing sync also re-requests the same window on every run, and with the clock frozen in
  // this harness that window's body and bounds never change, so RawArchive's dedup key (see
  // rawArchive.ts) swallows the second request whether or not the type is excluded - a raw-row
  // count could not tell the two cases apart here regardless of which walk is at fault. The
  // backfill cursor can: #backfillPass and #sprintPending are the walks *this file's* helper
  // filters, and their effect is exactly whether that cursor ever moves. (dueJobs, in
  // packages/core, filters the trailing sync itself now and has its own clock-free coverage in
  // packages/core/test/sync-state.test.ts and run-sync.test.ts.)
  it('is not walked by the backfill pass during a sync run', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const stores = harness.app.haelan.stores
    stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: [EXCLUDED_TYPE], nowMs: harness.clock.nowMs,
    })

    await harness.app.haelan.runner.trigger('manual')

    expect(stores.syncState.get('p1', EXCLUDED_TYPE)?.backfillCursorMs ?? null).toBeNull()
    expect(stores.syncState.get('p1', CONTROL_TYPE)?.backfillCursorMs).not.toBeNull()
  })

  it('is walked again once the exclusion is removed', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const stores = harness.app.haelan.stores
    stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: [EXCLUDED_TYPE], nowMs: harness.clock.nowMs,
    })
    await harness.app.haelan.runner.trigger('manual')
    expect(stores.syncState.get('p1', EXCLUDED_TYPE)?.backfillCursorMs ?? null).toBeNull()

    stores.excludedDataTypes.setFor({ personId: 'p1', dataTypeIds: [], nowMs: harness.clock.nowMs })
    await harness.app.haelan.runner.trigger('manual')

    expect(stores.syncState.get('p1', EXCLUDED_TYPE)?.backfillCursorMs).not.toBeNull()
  })

  it('do not affect another person', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const { stores, instance } = harness.app.haelan
    stores.people.create({
      id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', nowMs: harness.clock.nowMs,
    })
    instance.credentials.putRefreshToken({
      personId: 'p2', refreshToken: 'stub-refresh-token', scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })
    stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: [EXCLUDED_TYPE], nowMs: harness.clock.nowMs,
    })

    const p2Types = harness.app.haelan.runner.status('p2').backfill.map((row) => row.dataType)
    expect(p2Types).toEqual(listableIds)
  })

  // Nothing in this project deletes health history.
  it('deletes no rows that were already fetched', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const { stores, runner } = harness.app.haelan
    await runner.trigger('manual')
    const before = stores.archive.listFor('p1').filter((row) => row.dataType === EXCLUDED_TYPE).length
    expect(before).toBeGreaterThan(0)

    stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: [EXCLUDED_TYPE], nowMs: harness.clock.nowMs,
    })
    await runner.trigger('manual')

    expect(stores.archive.listFor('p1').filter((row) => row.dataType === EXCLUDED_TYPE).length).toBe(before)
  })
})
