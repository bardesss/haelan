import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { corruptArchivedBodies, openHaelan, schema, seedPerson } from '@haelan/core'
import { rebuildInWorker, rebuildInWorkerIfNeeded, reviveFailure, toSerializableFailure } from '../src/rebuildInWorker.ts'

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

describe('a failure crossing the thread boundary', () => {
  // The one part of this the rest of the file never touches: every other test asserts failures is
  // empty, so toSerializableFailure and reviveFailure could both be deleted and nothing here
  // would notice. structuredClone, which postMessage uses, copies message and stack out of the
  // built in Error subclasses only; better-sqlite3's SqliteError is not one of those, so an
  // uncopied failure arrives with its name and message undefined and runBootSequence, which
  // interpolates `failure.error.message` into the line naming the quarantined person, would tell
  // the operator that somebody could not be rebuilt because of undefined.
  //
  // Driven through a real rebuild rather than a hand built error, using boot.test.ts's
  // seedPersonWhoseRebuildFails technique: an archived body corrupted in place, so the replay
  // cannot inflate it. What that throws is a plain zlib Error, which structured clone does handle,
  // so this covers the revive half and the wiring around it. The half structured clone actually
  // breaks needs an error a rebuild cannot be made to throw on demand, and has its own test below.
  it('carries a message the boot log can print', async () => {
    const instance = openHaelan(dataDir, {})
    seedPerson(instance.db, 'p1')
    instance.archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: {},
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: '{}',
    })
    corruptArchivedBodies(instance.db, 'p1')
    instance.close()

    const outcome = await rebuildInWorker({ dataDir, log: () => {} })

    expect(outcome.failures.map((f) => f.personId)).toEqual(['p1'])
    const { error } = outcome.failures[0]!
    // A real Error on this side, not the plain object that crossed: RebuildFailure promises its
    // callers an Error and runBootSequence hands it straight to logError.
    expect(error).toBeInstanceOf(Error)
    // The message itself, quoted, because this is the string the operator reads and the exact
    // thing structured clone drops.
    expect(error.message).toContain('incorrect header check')
    expect(error.name).toBe('Error')
    // And the reasons ride along beside it, since the person is named by the same line.
    expect(outcome.failures[0]!.reasons.join(' ')).toContain('version')
  })
})

describe('the serialise and revive pair', () => {
  /** A real better-sqlite3 SqliteError, thrown the way one is: by breaking a constraint. */
  function realSqliteError(): Error & { code?: string } {
    const instance = openHaelan(dataDir, {})
    try {
      // personId 'p1' does not exist, so this trips the foreign key.
      instance.db.insert(schema.sources).values({
        id: 's1', personId: 'p1', externalId: 'X', displayName: 'X', kind: 'app', createdAtMs: 1,
      }).run()
      throw new Error('the insert was supposed to fail and did not')
    } catch (error) {
      return error as Error & { code?: string }
    } finally {
      instance.close()
    }
  }

  // The premise the pair exists for, asserted rather than assumed, because it is a fact about
  // structuredClone and better-sqlite3 rather than about this repo, and if a later better-sqlite3
  // built its errors through `class SqliteError extends Error` the flattening would become dead
  // code that nothing here would flag.
  it('is needed, because structured clone drops a SqliteError message on the floor', () => {
    const error = realSqliteError()
    expect(error.constructor.name).toBe('SqliteError')
    expect(error.message).toContain('FOREIGN KEY constraint failed')

    const cloned = structuredClone(error) as Error & { code?: string }

    // Not an Error at all on the far side, with the two fields the operator reads gone and only
    // the enumerable own property left. This is what postMessage would deliver unflattened.
    expect(cloned instanceof Error).toBe(false)
    expect(cloned.message).toBeUndefined()
    expect(cloned.name).toBeUndefined()
    expect(cloned.code).toBe(error.code)
  })

  // And the pair put through the same clone, which is the transport it is written against. Not a
  // direct call of one on the other's output: that would pass with both functions deleted.
  it('carries a SqliteError through structured clone intact', () => {
    const error = realSqliteError()

    const revived = reviveFailure(
      structuredClone(toSerializableFailure({ personId: 'p1', reasons: ['mapping version'], error })),
    )

    expect(revived.error).toBeInstanceOf(Error)
    expect(revived.error.message).toBe(error.message)
    expect(revived.error.name).toBe('SqliteError')
    // The enumerable extras ride along too. `code` is the one an operator grepping a boot log
    // for SQLITE_ anything would look for.
    expect((revived.error as Error & { code?: string }).code).toBe(error.code)
    expect(revived.personId).toBe('p1')
    expect(revived.reasons).toEqual(['mapping version'])
  })
})
