import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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
  // race would be flaky and could pass for the wrong reason on a fast rebuild; a pid cannot.
  // runRebuild has no awaits, so somewhere other than this process is exactly equivalent to this
  // event loop staying free, and that is the fact this asserts.
  //
  // A stronger claim than the thread id it replaces could make. A thread id is only ever "not the
  // main thread"; a pid can be held against this process's own, which is what makes the separate
  // address space - the thing rebuildWorker.ts's header exists for - the asserted property rather
  // than an implementation detail nothing would notice losing.
  it('runs the rebuild in another process', async () => {
    const outcome = await rebuildInWorker({ dataDir, log: () => {} })
    expect(outcome.pid).toBeGreaterThan(0)
    expect(outcome.pid).not.toBe(process.pid)
  })

  // A dead worker must reject. A pending promise here would hang shutdown, which awaits it before
  // closing SQLite precisely so it does not close under a write transaction.
  //
  // The brief's own version of this test pointed dataDir at a merely missing directory, on the
  // assumption that a missing directory stops the worker from starting. It does not: openDatabase
  // creates its directory with mkdirSync({ recursive: true }) (packages/core/src/db/open.ts), so
  // that path exercised the ordinary success case instead and never failed. What actually stops a
  // directory from being created is a file already sitting where a directory needs to go.
  //
  // The message is asserted, not just the rejection, and that is the part that would otherwise
  // have been lost silently in the move from a thread to a process. A worker thread that threw
  // uncaught fired `worker.on('error')` carrying the real Error; a forked child has no equivalent
  // and would report a bare exit code instead, so rebuildWorker.ts catches its own failures and
  // sends them. This holds that catch in place: ENOTDIR is what mkdirSync raises against a file
  // sitting where a directory needs to go, and an operator reading a boot log needs that rather
  // than "exited with code 1".
  it('rejects with the reason when the worker cannot start', async () => {
    const blocked = join(dataDir, 'blocked')
    writeFileSync(blocked, '')
    await expect(rebuildInWorker({ dataDir: join(blocked, 'nested'), log: () => {} }))
      .rejects.toThrow(/ENOTDIR|not a directory/i)
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
  // here: it follows from rebuildWorker.ts closing its instance in a `finally` around the rebuild,
  // and from rebuildInWorker's promise resolving out of the child's `exit` handler, which Node
  // fires only once the process is actually gone - which, now that it is a process rather than a
  // thread, the operating system guarantees has released every handle it held on the file.
  // A worker thread died with the process that made it. A forked child does not, so a rebuild can
  // outlive the server that started it - the one thing the process boundary takes away rather than
  // gives. rebuildWorker.ts bounds that at the next line the rebuild reports, and this holds the
  // bound in place.
  //
  // The exit code is not what this test is for. An orphan stops either way: without the check,
  // process.send() on a closed channel throws ERR_IPC_CHANNEL_CLOSED and the child dies of an
  // unhandled rejection, which is also a non zero exit - so asserting only the code would pass
  // against a deleted check, which is what the first version of this test did. What separates the
  // two is *how* it ends, so that is what is asserted: a parent that shut down is a normal end,
  // and an orphan must not write a crash on its way out for an operator to find later and wonder
  // about.
  //
  // The people are what make it deterministic. One person's rebuild is synchronous, so a child
  // given one person would finish and report before the channel could matter - the test would pass
  // for the wrong reason again. rebuildIfNeeded logs each person before rebuilding them and yields
  // between them, so disconnecting on the first of those lines leaves the rest of the queue on the
  // far side of a yield the child has to come back through.
  it('stops quietly when its parent goes away', async () => {
    const instance = openHaelan(dataDir, {})
    for (let i = 0; i < 20; i++) seedPerson(instance.db, `p${i}`)
    instance.close()

    const entry = fileURLToPath(new URL('../src/rebuildWorker.ts', import.meta.url))
    const child = fork(entry, [], {
      execArgv: process.execArgv.includes('--experimental-strip-types')
        ? process.execArgv
        : [...process.execArgv, '--experimental-strip-types'],
      // stderr piped rather than ignored, because it is the thing under test here. Production
      // ignores it (see rebuildInWorker.ts) precisely so nothing the child writes can reach a
      // stdout that might be a JSON-RPC stream, which is also why this has to be asserted here
      // rather than noticed in a log somewhere.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })

    const lines: string[] = []
    let stderr = ''
    let reportedDone = false
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('message', (message: { kind: string, line?: string }) => {
        if (message.kind === 'done') reportedDone = true
        if (message.kind !== 'log') return
        lines.push(message.line ?? '')
        // The first line naming a person proves the child is past its imports and into the loop,
        // which is the earliest moment a departed parent can mean anything to it.
        if (lines.length === 1 && child.connected) child.disconnect()
      })
      child.on('error', reject)
      child.on('exit', (exitCode) => { resolve(exitCode) })
      child.send({ dataDir })
    })

    // Cut short rather than racing to the end and exiting for its own reasons, which is the
    // precondition for anything below meaning something.
    expect(reportedDone, 'the child finished anyway, so this proved nothing').toBe(false)
    expect(lines.length).toBeLessThan(20)
    // Non zero, because the job genuinely did not finish.
    expect(code).toBe(1)
    // And quietly. This is the assertion that fails if the check in send() is deleted.
    expect(stderr, 'an orphaned rebuild crashed instead of stopping').not.toContain('ERR_IPC_CHANNEL_CLOSED')
    expect(stderr).not.toMatch(/unhandled|UnhandledPromiseRejection/i)
  })

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
  // process spawn, a second type strip and a second better-sqlite3 load for this case, and worse,
  // gained a way to fail: a worker that cannot start rejects, runBootSequence catches it and sync
  // never starts for anybody. A null pid is the observable that says no worker ran, since every
  // path that does start one reports the process it ran in.
  it('starts no worker when nobody needs rebuilding', async () => {
    const instance = openHaelan(dataDir, {})
    try {
      const outcome = await rebuildInWorkerIfNeeded({ instance, dataDir, log: () => {} })
      expect(outcome.pid).toBeNull()
      expect(outcome.failures).toEqual([])
    } finally {
      instance.close()
    }
  })

  // And the gate is a gate, not a lid. A person with no stamp is one a boot must rebuild, and
  // this is the branch that has to reach the worker: a pid that is not this process's own is the
  // same observable read the other way, and it can only come from a worker that actually ran.
  it('starts one when somebody does', async () => {
    const instance = openHaelan(dataDir, {})
    seedPerson(instance.db, 'p1')
    try {
      const lines: string[] = []
      const outcome = await rebuildInWorkerIfNeeded({
        instance, dataDir, log: (line) => lines.push(line),
      })
      expect(outcome.pid).toBeGreaterThan(0)
      expect(outcome.pid).not.toBe(process.pid)
      expect(outcome.failures).toEqual([])
      expect(lines.join(' '), 'the worker reported no progress at all').toContain('rebuild')
    } finally {
      instance.close()
    }
  })
})

describe('a failure crossing the process boundary', () => {
  // The one part of this the rest of the file never touches: every other test asserts failures is
  // empty, so toSerializableFailure and reviveFailure could both be deleted and nothing here
  // would notice. A forked child's IPC channel serialises with JSON.stringify, and `name`,
  // `message` and `stack` are non-enumerable own properties of every Error, so an unflattened
  // failure arrives with all three undefined and runBootSequence, which interpolates
  // `failure.error.message` into the line naming the quarantined person, would tell the operator
  // that somebody could not be rebuilt because of undefined.
  //
  // Driven through a real rebuild rather than a hand built error, using boot.test.ts's
  // seedPersonWhoseRebuildFails technique: an archived body corrupted in place, so the replay
  // cannot inflate it. What that throws is a plain zlib Error, and this end to end case is
  // strictly stronger than it was under the thread version: structuredClone did copy a plain
  // Error's message, so this test used to exercise only the revive half, and JSON does not, so it
  // now exercises the break as well as the repair.
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
    // thing the channel's JSON drops.
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
  // JSON.stringify and the Error shape rather than about this repo, and if the IPC channel were
  // ever switched to `serialization: 'advanced'` the flattening would become dead code that
  // nothing here would flag.
  //
  // Kept on a real SqliteError rather than a plain Error, even though JSON drops the message of
  // both, because `code` is the half that does survive: it is an enumerable own property, and it
  // is what an operator grepping a boot log for SQLITE_ anything would look for. A plain Error
  // would prove the loss without proving what has to be kept.
  it('is needed, because the channel JSON drops an error message on the floor', () => {
    const error = realSqliteError()
    expect(error.constructor.name).toBe('SqliteError')
    expect(error.message).toContain('FOREIGN KEY constraint failed')

    // Exactly what child_process does to a message before it crosses: its default serialisation
    // is JSON, so this is the transport rather than a stand-in for it.
    const sent = JSON.parse(JSON.stringify(error)) as Partial<Error> & { code?: string }

    // Not an Error at all on the far side, with the three fields the operator reads gone and only
    // the enumerable own property left. This is what send() would deliver unflattened.
    expect(sent instanceof Error).toBe(false)
    expect(sent.message).toBeUndefined()
    expect(sent.name).toBeUndefined()
    expect(sent.stack).toBeUndefined()
    expect(sent.code).toBe(error.code)
  })

  // And the pair put through that same JSON, which is the transport it is written against. Not a
  // direct call of one on the other's output: that would pass with both functions deleted.
  it('carries a SqliteError through the channel JSON intact', () => {
    const error = realSqliteError()

    const revived = reviveFailure(
      JSON.parse(JSON.stringify(
        toSerializableFailure({ personId: 'p1', reasons: ['mapping version'], error }),
      )),
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
