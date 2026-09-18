import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AccountStore, McpCallLog, McpTokenStore, PeopleStore, SessionStore, SettingsStore,
  SourceRegistry, SyncStateStore, openHaelan,
} from '@haelan/core'
import type { Instance } from '@haelan/core'
import type { Stores } from '../src/app.ts'
import { drainOnce, shouldDrain } from '../src/derive/drainer.ts'

describe('shouldDrain', () => {
  it('stands down while a rebuild holds the write lock', () => {
    // The boot rebuild holds the write lock for its whole run, so a second writer on the file is
    // an outage rather than a slow request.
    expect(shouldDrain({ rebuildRunning: true, queueSize: 500 })).toBe(false)
  })

  it('stays idle when nothing is queued', () => {
    expect(shouldDrain({ rebuildRunning: false, queueSize: 0 })).toBe(false)
  })

  it('drains when there is work and no rebuild', () => {
    expect(shouldDrain({ rebuildRunning: false, queueSize: 1 })).toBe(true)
  })
})

// A real instance and a real Stores, built the same way app.ts builds them, rather than a mock
// of either: drainOnce's own two jobs, the eligibility gate and the error containment, are only
// honestly checked by watching what a real DeriveQueue and a real runDerive actually did, not by
// asserting a mock was called.
function withInstance<T>(fn: (instance: Instance, stores: Stores) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-drainer-'))
  const instance = openHaelan(dir, {})
  const stores: Stores = {
    accounts: new AccountStore(instance.db),
    people: new PeopleStore(instance.db),
    sessions: new SessionStore(instance.db),
    settings: new SettingsStore(instance.db),
    credentials: instance.credentials,
    syncState: new SyncStateStore(instance.db),
    sources: new SourceRegistry(instance.db),
    archive: instance.archive,
    excludedDataTypes: instance.excludedDataTypes,
    mcpTokens: new McpTokenStore(instance.db),
    mcpCalls: new McpCallLog(instance.db),
  }
  // Closed before the directory is removed, in that order, inside one finally: an open handle
  // still on the file is what turns rmSync's cleanup into the real failure here rather than
  // whatever the test actually asserted.
  try {
    return fn(instance, stores)
  } finally {
    instance.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('drainOnce', () => {
  it('excludes a person needing a rebuild from what it derives', () => {
    withInstance((instance, stores) => {
      stores.people.create({ id: 'p1', displayName: 'Robin', timezone: 'Europe/Amsterdam', nowMs: 0 })
      stores.people.create({ id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', nowMs: 0 })
      // p2's derived rows were built by an older mapper: the same state stampBuiltVersions
      // simulates for the sync runner's own quarantine test.
      stores.people.stampBuiltVersions({ id: 'p2', mappingVersion: 0, derivationVersion: 0 })
      instance.deriveQueue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })
      instance.deriveQueue.markDirty({ personId: 'p2', localDate: '2026-08-22', nowMs: 2 })

      const daysDerived = drainOnce({ instance, stores, nowMs: () => 3, rebuildRunning: () => false })

      expect(daysDerived).toBe(1)
      // p1's day is gone from the queue, which only happens if runDerive claimed and cleared it.
      // p2's day is still exactly where markDirty left it, which only happens if runDerive was
      // never given p2's id to claim. Neither fact is visible from the return value alone.
      expect(instance.deriveQueue.claim(10)).toEqual([{ personId: 'p2', localDate: '2026-08-22' }])
    })
  })

  it('does not touch the queue while a rebuild is running', () => {
    withInstance((instance, stores) => {
      stores.people.create({ id: 'p1', displayName: 'Robin', timezone: 'Europe/Amsterdam', nowMs: 0 })
      instance.deriveQueue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })

      const daysDerived = drainOnce({ instance, stores, nowMs: () => 2, rebuildRunning: () => true })

      expect(daysDerived).toBe(0)
      // The stronger half of this test: not just that the count says nothing happened, but that
      // the day is still queued, which is the only way to tell "returned 0 without running" apart
      // from "ran, and happened to derive nothing".
      expect(instance.deriveQueue.claim(10)).toEqual([{ personId: 'p1', localDate: '2026-08-22' }])
    })
  })

  it('returns zero rather than throwing when derivation fails', () => {
    withInstance((instance, stores) => {
      stores.people.create({ id: 'p1', displayName: 'Robin', timezone: 'Europe/Amsterdam', nowMs: 0 })
      instance.deriveQueue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })

      // A settings read that fails for real, reached from inside runDerive itself once it is
      // called, rather than a mock of drainOnce or of runDerive. This is the same collaborator
      // the sync runner and the annotations drain route read through; here it is broken on
      // purpose to stand in for whatever a real derivation defect would throw.
      const brokenSettings = { get: () => { throw new Error('settings read failed') } } as unknown as Instance['settings']

      const daysDerived = drainOnce({
        instance: { ...instance, settings: brokenSettings },
        stores,
        nowMs: () => 2,
        rebuildRunning: () => false,
      })

      expect(daysDerived).toBe(0)
    })
  })
})
