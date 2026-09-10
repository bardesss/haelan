import { describe, expect, it } from 'vitest'
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

  // setInterval waits a whole interval before its first call, so without this an instance
  // restarted more often than its interval would never back up at all - the same hazard
  // SyncRunner.start() documents and avoids (sync/runner.ts). start() itself is what has to take
  // the first tick; dueNow()/runIfDue() alone, called directly the way every test above does,
  // would never catch a start() that forgot to.
  it('takes a backup immediately on start rather than waiting a full interval', () => {
    withDir((dir) => {
      const instance = openHaelan(dir, {})
      try {
        const tick = new MaintenanceTick({
          instance, dir, keep: 7, intervalHours: 24, now: () => 1_770_000_000_000,
        })
        expect(listBackups(dir)).toHaveLength(0)
        tick.start()
        try {
          expect(listBackups(dir)).toHaveLength(1)
        } finally { tick.stop() }
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
})
