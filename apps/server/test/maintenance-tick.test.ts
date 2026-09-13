import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeDatabase, listBackups, openHaelan, schema, seedPerson,
  McpCallLog, McpTokenStore, MCP_CALL_LOG_TTL_MS,
} from '@haelan/core'
import type { Instance } from '@haelan/core'
import { MaintenanceTick } from '../src/maintenance/tick.ts'

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-maint-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('MaintenanceTick', () => {
  it('is due on an instance that has never backed up', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => 1_770_000_000_000,
        })
        expect(tick.dueNow()).toBe(true)
      } finally { instance.close() }
    })
  })

  it('is not due again until the interval has passed, and is due once it has', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        let nowMs = 1_770_000_000_000
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => nowMs,
        })
        expect(tick.runIfDue()).not.toBeNull()
        expect(tick.dueNow()).toBe(false)

        nowMs += 23 * 3_600_000
        expect(tick.dueNow()).toBe(false)
        nowMs += 2 * 3_600_000
        expect(tick.dueNow()).toBe(true)
      } finally { instance.close() }
    })
  })

  // The reason the policy is a function rather than two numbers captured at construction: both
  // were HAELAN_BACKUP_KEEP and HAELAN_BACKUP_INTERVAL_HOURS, and a household turning backups off
  // on the Maintenance card must not have to restart the container for this schedule to notice.
  it('follows a policy that changes under it, without being rebuilt', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        let policy = { keep: 7, intervalHours: 24 }
        const tick = new MaintenanceTick({
          instance, dir, policy: () => policy, now: () => 1_770_000_000_000,
        })
        expect(tick.dueNow()).toBe(true)
        policy = { keep: 0, intervalHours: 24 }
        expect(tick.dueNow()).toBe(false)
        expect(tick.runIfDue()).toBeNull()
        expect(listBackups(dir)).toHaveLength(0)
      } finally { instance.close() }
    })
  })

  it('keeps only what retention allows as it goes', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        let nowMs = 1_770_000_000_000
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 2, intervalHours: 24 }), now: () => nowMs,
        })
        for (let day = 0; day < 4; day += 1) {
          tick.runIfDue()
          nowMs += 25 * 3_600_000
        }
        expect(listBackups(dir)).toHaveLength(2)
      } finally { instance.close() }
    })
  })

  // A policy of keep 0 is how an operator who backs the volume up by other means turns this off. It must
  // mean "do not take backups", not "take one and immediately delete it", which would spend the
  // disk and the time and leave nothing.
  it('takes no backup at all when retention is zero', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 0, intervalHours: 24 }), now: () => 1_770_000_000_000,
        })
        expect(tick.dueNow()).toBe(false)
        expect(tick.runIfDue()).toBeNull()
        expect(listBackups(dir)).toHaveLength(0)
      } finally { instance.close() }
    })
  })

  // setInterval waits a whole interval before its first call, so without a first tick an instance
  // restarted more often than its interval would never back up at all - the same hazard
  // SyncRunner.start() documents and avoids (sync/runner.ts). Delayed a minute rather than run
  // synchronously in start(), though: a first tick can mean a full VACUUM INTO plus an
  // integrity_check on the main thread, on top of the boot vacuum's own stall, and that must not
  // run before the app has answered a single request. dueNow()/runIfDue() alone, called directly
  // the way every test above does, would never catch a start() that forgot to schedule it at all.
  it('takes a backup a minute after start, not immediately and not a full interval later', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => 1_770_000_000_000,
        })
        vi.useFakeTimers()
        try {
          expect(listBackups(dir)).toHaveLength(0)
          tick.start()
          // Not yet: the app should be up and serving before this pays its own cost.
          expect(listBackups(dir)).toHaveLength(0)
          vi.advanceTimersByTime(59_999)
          expect(listBackups(dir)).toHaveLength(0)
          vi.advanceTimersByTime(1)
          expect(listBackups(dir)).toHaveLength(1)
        } finally {
          tick.stop()
          vi.useRealTimers()
        }
      } finally { instance.close() }
    })
  })

  // The hazard this whole task exists to close: runBackup is fully synchronous and this is
  // called from inside a bare setInterval callback, with no process.on('uncaughtException')
  // anywhere in the app to catch what escapes one. A throw here used to take the whole process
  // down; reproduced with a real throw (a plain file where runBackup's mkdirSync expects to
  // create the backups directory), not a stub, so this proves the catch actually wraps the real
  // call rather than a call this test invented.
  it('survives a backup that throws, rather than letting it escape the tick', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        writeFileSync(join(dir, 'backups'), 'not a directory')
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => 1_770_000_000_000,
        })
        expect(() => tick.runIfDue()).not.toThrow()
        expect(tick.runIfDue()).toBeNull()
      } finally { instance.close() }
    })
  })

  // backupDecision reads three pragmas and calls statfsSync - a stale mount or an IO error there
  // used to escape runIfDue uncaught, because the call sat outside its try. Reproduced with a
  // real throw, not a stub: closing the database connection out from under the tick makes every
  // pragma call throw "The database connection is not open", the same way a removed mount would.
  // Also proves start()'s own reordering: the hourly interval and the delayed first tick are both
  // armed before either has ever run, so a throw from the first tick can never leave an instance
  // with no timer at all - the silent-never-backs-up failure this unit exists to prevent.
  it('arms both timers before the first tick runs, and survives that tick throwing', () => {
    withDir((dir) => {
      // No instance.close() in a finally here, on purpose: the connection is closed by hand
      // below to produce the throw, and closing it twice is not this test's business - withDir's
      // own finally still removes the directory either way.
      const instance = openHaelan(dir, {})
      instance.db.$client.close()
      const tick = new MaintenanceTick({
        instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => 1_770_000_000_000,
      })
      vi.useFakeTimers()
      try {
        tick.start()
        // Both timers exist immediately, before the delayed first tick has ever had a chance
        // to run (and throw): the hourly interval and the one-shot delay.
        expect(vi.getTimerCount()).toBe(2)

        expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
        // The one-shot timer fired (and its throw was caught inside runIfDue) and is gone; the
        // recurring interval it was armed alongside is still here and still alive.
        expect(vi.getTimerCount()).toBe(1)
      } finally {
        tick.stop()
        vi.useRealTimers()
      }
    })
  })
})

const CALL_LOG_NOW = 1_770_000_000_000

// Seeds the person/account/token chain a real `mcp_calls` row requires (`token_id` is NOT NULL
// with a foreign key, and `openDatabase` turns foreign keys on), then one call at `nowMs` and one
// at `nowMs + MCP_CALL_LOG_TTL_MS` - so a tick clock set past the horizon leaves exactly one row
// on each side of it.
function seedCallLog(instance: Instance, nowMs: number): string {
  const accountId = 'acct-alice'
  seedPerson(instance.db, 'alice')
  instance.db.insert(schema.accounts).values({
    id: accountId, personId: 'alice', username: 'alice',
    passwordHash: 'x', isAdmin: false, failedAttempts: 0, lockedUntilMs: null,
    createdAtMs: nowMs, disabledAtMs: null,
  }).run()
  new McpTokenStore(instance.db).create({ id: 't1', accountId, label: 'laptop', days: 90, nowMs })
  const calls = new McpCallLog(instance.db)
  calls.record({
    id: 'old', tokenId: 't1', atMs: nowMs, tool: 'query_series', rowCount: 12, durationMs: 3, outcome: 'ok',
  })
  calls.record({
    id: 'new', tokenId: 't1', atMs: nowMs + MCP_CALL_LOG_TTL_MS,
    tool: 'query_series', rowCount: 12, durationMs: 3, outcome: 'ok',
  })
  return accountId
}

describe('the call log prune', () => {
  // Each case seeds one account, one token and two calls - one at NOW and one at
  // NOW + MCP_CALL_LOG_TTL_MS - then advances the tick's clock past the horizon, so exactly one
  // row is past it and exactly one is not.

  it('removes rows past the horizon and leaves the rest', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        const accountId = seedCallLog(instance, CALL_LOG_NOW)
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => CALL_LOG_NOW + MCP_CALL_LOG_TTL_MS + 1,
        })
        expect(tick.pruneCallLog()).toBe(1)
        expect(new McpCallLog(instance.db).listForAccount(accountId, 10).map((c) => c.id)).toEqual(['new'])
      } finally { instance.close() }
    })
  })

  it('runs even when backups are switched off, which dueNow declines for', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        seedCallLog(instance, CALL_LOG_NOW)
        // Built with a policy of keep 0. runIfDue() returns null without reaching anything; the prune still
        // runs, which is the whole reason it is not inside that gate.
        const tick = new MaintenanceTick({
          instance, dir, policy: () => ({ keep: 0, intervalHours: 24 }), now: () => CALL_LOG_NOW + MCP_CALL_LOG_TTL_MS + 1,
        })
        expect(tick.dueNow()).toBe(false)
        expect(tick.pruneCallLog()).toBe(1)
      } finally { instance.close() }
    })
  })

  it('survives a throw rather than taking the process down', () => {
    withDir((dir) => {
      // No instance.close() in a finally here, on purpose: the connection is closed by hand
      // below to produce the throw, and closing it twice is not this test's business - withDir's
      // own finally still removes the directory either way.
      const instance = openHaelan(dir, {})
      seedCallLog(instance, CALL_LOG_NOW)
      const tick = new MaintenanceTick({
        instance, dir, policy: () => ({ keep: 7, intervalHours: 24 }), now: () => CALL_LOG_NOW + MCP_CALL_LOG_TTL_MS + 1,
      })
      // Close the database under the tick, then prune. This is called from inside a bare
      // setInterval with no process.on('uncaughtException') anywhere in this app, so an escaping
      // throw is not a failed prune - it is the instance.
      closeDatabase(instance.db)
      // One assertion for both properties: it did not throw (the expression evaluated at all),
      // and the failure was swallowed into "pruned nothing" rather than a thrown error the bare
      // setInterval calling this has no handler for.
      expect(tick.pruneCallLog()).toBe(0)
    })
  })
})
