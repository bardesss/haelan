import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHaelan, seedPerson } from '@haelan/core'
import { rebuildInWorker, rebuildInWorkerIfNeeded } from '../src/rebuildInWorker.ts'

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

  // A dead worker must reject. A pending promise here would hang shutdown, which awaits it before
  // closing SQLite precisely so it does not close under a write transaction.
  //
  // The brief's own version of this test pointed dataDir at a merely missing directory, on the
  // assumption that a missing directory stops the worker from starting. It does not: openDatabase
  // creates its directory with mkdirSync({ recursive: true }) (packages/core/src/db/open.ts), so
  // that path exercised the ordinary success case instead and never failed. What actually stops a
  // directory from being created is a file already sitting where a directory needs to go.
  it('rejects when the worker cannot start', async () => {
    const blocked = join(dataDir, 'blocked')
    writeFileSync(blocked, '')
    await expect(rebuildInWorker({ dataDir: join(blocked, 'nested'), log: () => {} }))
      .rejects.toThrow()
  })

  // A person with no stamp is one a boot rebuilds, so this exercises the real path rather than the
  // empty-directory shortcut the first test takes.
  it('rebuilds a person who needs it and reports through the log channel', async () => {
    const instance = openHaelan(dataDir, {})
    seedPerson(instance.db, 'p1')
    instance.close()

    const lines: string[] = []
    const outcome = await rebuildInWorker({ dataDir, log: (line) => lines.push(line) })

    expect(outcome.failures).toEqual([])
    expect(lines.join(' '), 'the worker reported no progress at all').toContain('rebuild')
  })

  // Runs a real rebuild end to end against a real data directory and checks that the file it
  // leaves behind opens and closes cleanly afterward. It does not prove the ordering index.ts's
  // shutdown depends on: packages/core/src/db/open.ts puts the database in WAL mode with a 5
  // second busy timeout, and under WAL a second connection's open and close do not block on a
  // writer, so this assertion would pass the same way even if the worker's connection were still
  // open. The close-before-exit ordering shutdown relies on is structural rather than asserted
  // here: it follows from rebuildWorker.ts closing its instance in a `finally` around the whole
  // module body, and from rebuildInWorker's promise resolving out of the worker's `exit` handler,
  // which Node fires only after that module body, `finally` included, has finished running.
  it('leaves the database closable the moment its promise settles', async () => {
    const instance = openHaelan(dataDir, {})
    seedPerson(instance.db, 'p1')
    instance.close()

    await rebuildInWorker({ dataDir, log: () => {} })

    const after = openHaelan(dataDir, {})
    expect(() => { after.close() }).not.toThrow()
  })
})

describe('rebuildInWorkerIfNeeded', () => {
  // The common boot by a wide margin: a restart, not a version bump. Every boot used to pay a
  // thread spawn, a second type strip and a second better-sqlite3 load for this case, and worse,
  // gained a way to fail: a worker that cannot start rejects, runBootSequence catches it and sync
  // never starts for anybody. A null threadId is the observable that says no worker ran, since
  // every path that does start one reports the id it ran on.
  it('starts no worker when nobody needs rebuilding', async () => {
    const instance = openHaelan(dataDir, {})
    try {
      const outcome = await rebuildInWorkerIfNeeded({ instance, dataDir, log: () => {} })
      expect(outcome.threadId).toBeNull()
      expect(outcome.failures).toEqual([])
    } finally {
      instance.close()
    }
  })

  // And the gate is a gate, not a lid. A person with no stamp is one a boot must rebuild, and
  // this is the branch that has to reach the worker: a positive threadId is the same observable
  // read the other way, and it can only come from a worker that actually ran.
  it('starts one when somebody does', async () => {
    const instance = openHaelan(dataDir, {})
    seedPerson(instance.db, 'p1')
    try {
      const lines: string[] = []
      const outcome = await rebuildInWorkerIfNeeded({
        instance, dataDir, log: (line) => lines.push(line),
      })
      expect(outcome.threadId).toBeGreaterThan(0)
      expect(outcome.failures).toEqual([])
      expect(lines.join(' '), 'the worker reported no progress at all').toContain('rebuild')
    } finally {
      instance.close()
    }
  })
})
