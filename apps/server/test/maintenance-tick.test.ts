import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
})
