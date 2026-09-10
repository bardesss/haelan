import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBackups, openHaelan } from '@haelan/core'
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
          instance, dir, keep: 7, intervalHours: 24, now: () => 1_770_000_000_000,
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
          instance, dir, keep: 7, intervalHours: 24, now: () => nowMs,
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

  it('keeps only what retention allows as it goes', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        let nowMs = 1_770_000_000_000
        const tick = new MaintenanceTick({ instance, dir, keep: 2, intervalHours: 24, now: () => nowMs })
        for (let day = 0; day < 4; day += 1) {
          tick.runIfDue()
          nowMs += 25 * 3_600_000
        }
        expect(listBackups(dir)).toHaveLength(2)
      } finally { instance.close() }
    })
  })

  // keep: 0 is how an operator who backs the volume up by other means turns this off. It must
  // mean "do not take backups", not "take one and immediately delete it", which would spend the
  // disk and the time and leave nothing.
  it('takes no backup at all when retention is zero', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        const tick = new MaintenanceTick({
          instance, dir, keep: 0, intervalHours: 24, now: () => 1_770_000_000_000,
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
          instance, dir, keep: 7, intervalHours: 24, now: () => 1_770_000_000_000,
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
          instance, dir, keep: 7, intervalHours: 24, now: () => 1_770_000_000_000,
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
        instance, dir, keep: 7, intervalHours: 24, now: () => 1_770_000_000_000,
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
