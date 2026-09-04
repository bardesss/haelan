import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildInWorker } from '../src/rebuildInWorker.ts'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'haelan-worker-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

describe('rebuildInWorker', () => {
  // An empty instance needs no rebuild, so this proves the whole round trip works: the worker
  // starts, opens its own connection, runs, reports and exits. Everything else builds on it.
  it('runs to completion against a fresh data directory and reports no failures', async () => {
    const lines: string[] = []
    const outcome = await rebuildInWorker({ dataDir, log: (line) => lines.push(line) })
    expect(outcome.failures).toEqual([])
  })

  // The property the whole task exists for, asserted structurally rather than by timing. A timer
  // race would be flaky and could pass for the wrong reason on a fast rebuild; the thread id
  // cannot. runRebuild has no awaits, so off the main thread is exactly equivalent to the event
  // loop staying free, and that is the fact this asserts.
  it('runs the rebuild off the main thread', async () => {
    const outcome = await rebuildInWorker({ dataDir, log: () => {} })
    expect(outcome.threadId).toBeGreaterThan(0)
  })
})
