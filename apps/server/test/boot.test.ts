import { describe, it, test, expect, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corruptArchivedBodies, openHaelan, sampleTarget, schema, seedPerson } from '@haelan/core'
import type { Instance } from '@haelan/core'
import { rebuildIfNeeded, runBootSequence } from '../src/rebuild.ts'

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let child: ChildProcess | null = null
let dir: string | null = null

async function stopChild(): Promise<void> {
  // Windows keeps the SQLite file locked until the child has actually gone, so the exit is
  // awaited rather than assumed: removing the directory a millisecond after kill() fails with
  // EPERM and reports as a test failure that has nothing to do with the test.
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
    child.kill()
    await exited
  }
  child = null
}

afterEach(async () => {
  await stopChild()
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

/** A port nothing is listening on, found by briefly listening on one and letting go. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const { port } = address
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())))
  return port
}

/**
 * The command `pnpm start` actually runs, read from package.json rather than restated, so a
 * change to the dev script has to come here and be considered rather than silently escaping
 * this test.
 */
function devCommand(): string[] {
  const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
    scripts: { dev: string }
  }
  const parts = pkg.scripts.dev.split(/\s+/)
  expect(parts[0], 'the dev script must invoke node directly').toBe('node')
  return parts.slice(1)
}

/** The node flags each entry script passes, so the two cannot drift apart unnoticed. */
function flagsOf(command: string): string[] {
  return command.split(/\s+/).filter((part) => part.startsWith('--'))
}

/**
 * How long one attempt waits for the child to answer, as a wall-clock deadline rather than a
 * count of polls. The count was the bug: a hundred iterations of "sleep 100ms then fetch" is only
 * a ten second budget while the fetch is free, and on a saturated machine it is not - one attempt
 * measured 15.4s. A deadline means the budget is the budget whatever else the machine is doing.
 */
const READY_DEADLINE_MS = 20_000

/**
 * Generous on purpose: three attempts of READY_DEADLINE_MS plus the spawns. A hang-detector, not
 * a performance assertion - this test costs about 1s idle and 3s with two other full suites
 * running, so approaching this number means something is genuinely stuck.
 */
const BOOT_BUDGET_MS = 90_000

interface BootOutcome {
  ok: boolean
  output: string
  health?: unknown
  setupState?: unknown
}

async function bootOnce(dataDir: string): Promise<BootOutcome> {
  const port = await freePort()
  child = spawn(process.execPath, devCommand(), {
    cwd: SERVER_ROOT,
    env: { ...process.env, HAELAN_DATA_DIR: dataDir, HAELAN_PORT: String(port), HAELAN_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

  let exited = false
  child.once('exit', () => { exited = true })

  const deadline = Date.now() + READY_DEADLINE_MS
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) {
        const health: unknown = await response.json()
        const state = await fetch(`http://127.0.0.1:${port}/api/setup/state`)
        return { ok: true, output, health, setupState: await state.json() as unknown }
      }
    } catch {
      // Not up yet. The exit flag is what turns a crash into a prompt failure rather than
      // letting this loop spin out the whole deadline and report nothing useful.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  await stopChild()
  return { ok: false, output }
}

describe('the entry point boots', () => {
  // Every other server test builds the app in process, where vitest has already compiled the
  // TypeScript. That is why the whole suite passed while `pnpm start` could not start at all:
  // Node's type stripping is strip-only and rejects syntax vitest accepts, so nothing short of
  // running the real command finds out. Spawning it is the only assertion that would have.
  it('runs the real command against a real data directory and answers a health check', async () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-boot-'))

    // freePort finds a port by letting one go, so another test binding port 0 in the same run
    // can take it in between. Retrying on a fresh port keeps that race from reading as a boot
    // failure, which is the one thing this test exists to report accurately.
    let lastFailure = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await bootOnce(dir)
      if (outcome.ok) {
        expect(outcome.health).toEqual({ ok: true })
        // A fresh volume boots straight into the wizard, which is the state a first run is in.
        expect(outcome.setupState).toEqual({ step: 'account', companionMode: false })
        return
      }
      lastFailure = outcome.output
      // Silence is retryable for the same reason a port clash is: it says the machine was busy,
      // not that the server is broken. An empty transcript means the child never got far enough
      // to say anything - a cold start losing a CPU race to twenty other vitest forks - whereas a
      // real boot failure is loud, which is the entire reason this test exists. So any output at
      // all is reported immediately rather than retried into a slower, later failure.
      const busy = /EADDRINUSE|address already in use/i.test(outcome.output) || outcome.output.trim() === ''
      if (!busy) break
    }
    throw new Error(lastFailure.trim() === ''
      // The old message ended in a colon and a blank line, which reads like the server
      // failed and then declined to explain itself.
      ? `the server never answered within ${READY_DEADLINE_MS}ms on any of 3 attempts, and wrote nothing to stdout or stderr`
      : `the server did not boot:\n${lastFailure}`)
  }, BOOT_BUDGET_MS)

  it('starts the same way from the repository root as it does from the package', () => {
    // pnpm start and pnpm dev:server are two doors into one process. Only the first is spawned
    // above, so this pins the second: a flag added to one and not the other means the command
    // the documentation gives people is not the command this test proved.
    const root = JSON.parse(readFileSync(join(SERVER_ROOT, '../../package.json'), 'utf8')) as {
      scripts: { start: string }
    }
    const server = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
      scripts: { dev: string }
    }
    expect(flagsOf(root.scripts.start)).toEqual(flagsOf(server.scripts.dev))

    // And it runs node itself rather than delegating, so its working directory is the
    // repository root and a relative HAELAN_DATA_DIR lands where the README says it does.
    expect(root.scripts.start.startsWith('node ')).toBe(true)
  })
})

interface BootHarness {
  instance: Instance
  /** A person whose rows predate DERIVATION_VERSION and MAPPING_VERSION: never built at all. */
  seedUnstampedPerson: (id: string) => void
  /** A correction naming a sample the archive will never reproduce, so the rebuild orphans it. */
  seedOverrideOnAMissingSample: (id: string) => void
  /** A ranking on a source no payload will reproduce, so the rebuild takes the ranking with it. */
  seedRankingOnAStaleSource: (id: string) => void
  /** An unstamped person whose archive cannot be replayed at all, so their rebuild throws. */
  seedPersonWhoseRebuildFails: (id: string) => void
}

/**
 * An in-process instance on its own temporary data directory, the same construction index.ts
 * does, without the fastify app or the child process boot.test's other tests spawn: rebuildIfNeeded
 * only ever touches `instance`, so a full server is a detail these tests do not need.
 */
async function bootHarness(): Promise<BootHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-boot-harness-'))
  const instance = openHaelan(dir, {})
  bootHarnesses.push({ instance, dir })
  return {
    instance,
    seedUnstampedPerson: (id) => { seedPerson(instance.db, id) },
    seedOverrideOnAMissingSample: (id) => {
      instance.overrides.put({
        personId: id,
        scope: 'sample',
        targetKey: sampleTarget({ source: 'a-source-no-payload-will-ever-produce', metric: 'heart_rate', utcMs: 0 }),
        action: 'exclude',
        reason: 'test fixture: a correction on a reading that will not survive the rebuild',
        nowMs: 1,
      })
    },
    seedPersonWhoseRebuildFails: (id) => {
      seedPerson(instance.db, id)
      instance.archive.put({
        personId: id, dataType: 'heart-rate', requestParams: {},
        windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
        body: '{}',
      })
      corruptArchivedBodies(instance.db, id)
    },
    seedRankingOnAStaleSource: (id) => {
      // Straight into the tables rather than through SourcePriorityStore.put, which would also
      // mark days dirty. What this fixture is about is a ranking that outlived the source it
      // named, and the store's own queueing has nothing to do with that.
      instance.db.insert(schema.sources).values({
        id: 'a-source-no-payload-will-ever-produce', personId: id,
        externalId: 'HEALTH_CONNECT', displayName: 'HEALTH_CONNECT', kind: 'app', createdAtMs: 1,
      }).run()
      instance.db.insert(schema.sourcePriority).values({
        personId: id, metric: 'heart_rate',
        sourceId: 'a-source-no-payload-will-ever-produce', rank: 0,
      }).run()
    },
  }
}

// Closed and removed after each test rather than by the test itself, so a bootHarness() call
// reads exactly like the brief that specifies it and every test still leaves its temp directory
// and its open database behind it.
const bootHarnesses: { instance: Instance, dir: string }[] = []

describe('rebuildIfNeeded', () => {
  afterEach(() => {
    while (bootHarnesses.length > 0) {
      const h = bootHarnesses.pop()!
      h.instance.close()
      rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('rebuilds a person whose rows predate the current versions', async () => {
    const h = await bootHarness()
    h.seedUnstampedPerson('p1')

    const reports = await rebuildIfNeeded({
      instance: h.instance, nowMs: () => 1, log: () => {},
    })

    expect(reports.people.map((r) => r.personId)).toEqual(['p1'])
  })

  test('does nothing when every person is already current', async () => {
    const h = await bootHarness()
    h.seedUnstampedPerson('p1')
    await rebuildIfNeeded({ instance: h.instance, nowMs: () => 1, log: () => {} })

    const second = await rebuildIfNeeded({
      instance: h.instance, nowMs: () => 2, log: () => {},
    })

    expect(second).toEqual({ people: [], failures: [] })
  })

  test('reports each person and why, so an operator can read the log', async () => {
    const h = await bootHarness()
    h.seedUnstampedPerson('p1')
    const lines: string[] = []

    await rebuildIfNeeded({ instance: h.instance, nowMs: () => 1, log: (l) => lines.push(l) })

    expect(lines.some((l) => l.includes('p1'))).toBe(true)
    expect(lines.some((l) => l.includes('mapping version unrecorded'))).toBe(true)
  })

  test('an orphaned override is named in the log rather than swallowed', async () => {
    const h = await bootHarness()
    h.seedUnstampedPerson('p1')
    h.seedOverrideOnAMissingSample('p1')
    const lines: string[] = []

    await rebuildIfNeeded({ instance: h.instance, nowMs: () => 1, log: (l) => lines.push(l) })

    expect(lines.some((l) => l.includes('override'))).toBe(true)
  })

  test('a ranking lost with its source is called out, not folded into the source count', async () => {
    const h = await bootHarness()
    h.seedUnstampedPerson('p1')
    h.seedRankingOnAStaleSource('p1')
    const lines: string[] = []

    await rebuildIfNeeded({ instance: h.instance, nowMs: () => 1, log: (l) => lines.push(l) })

    // A household member's ranking is the one thing a rebuild destroys that no rebuild can put
    // back, and it cannot be re-targeted either: the stale identity carries no record of which
    // new identity replaced it. So the log has to say it plainly enough that whoever reads it
    // knows there is something for them to do.
    const said = lines.find((l) => l.includes('ranking'))
    expect(said).toBeDefined()
    expect(said).toContain('set them again')
  })

  test('a person whose rebuild throws is named, with the error, and the rest still rebuild', async () => {
    const h = await bootHarness()
    h.seedPersonWhoseRebuildFails('p1')
    h.seedUnstampedPerson('p2')
    const lines: string[] = []

    const report = await rebuildIfNeeded({
      instance: h.instance, nowMs: () => 1, log: (l) => lines.push(l),
    })

    // p2 is rebuilt even though p1, ahead of them in the loop, threw. Before this the loop
    // aborted, so a single bad payload stopped every household member ingesting until somebody
    // edited code, and intraday samples have a shelf life.
    expect(report.people.map((r) => r.personId)).toEqual(['p2'])
    expect(report.failures.map((f) => f.personId)).toEqual(['p1'])

    // Named individually and quoted, the way an orphaned override is, rather than folded into a
    // count. A count tells an operator that something is wrong; this tells them which person and
    // what to go and look at.
    const said = lines.find((l) => l.includes('p1') && l.includes('could not be rebuilt'))
    expect(said).toBeDefined()
    expect(said).toContain('incorrect header check')
    // And what it means for them, since the consequence is not obvious from the failure alone:
    // this person stops syncing until a later boot rebuilds them.
    expect(said).toContain('skipped by sync')
  })

  test('a failed person is left unstamped, so the next call tries them again', async () => {
    const h = await bootHarness()
    h.seedPersonWhoseRebuildFails('p1')

    await rebuildIfNeeded({ instance: h.instance, nowMs: () => 1, log: () => {} })
    // No operator action in between. Retrying has to be the default, because the fix for a
    // payload no mapper handles is a new mapper, and that arrives as a restart.
    const second = await rebuildIfNeeded({ instance: h.instance, nowMs: () => 2, log: () => {} })

    expect(second.failures.map((f) => f.personId)).toEqual(['p1'])
  })

  test('yields between people rather than only after all of them', async () => {
    const h = await bootHarness()
    h.seedUnstampedPerson('p1')
    h.seedUnstampedPerson('p2')
    const lines: string[] = []

    // Faking only setImmediate, not the wall clock: this pins the interleaving itself rather
    // than a timing coincidence. Cheap by construction, since a faked timer never actually
    // waits, which is how this holds without touching any per test timeout: issue #32's raised
    // budgets are exactly the thing issue #47 is open about, and a test that cannot be slow
    // needs no budget at all.
    vi.useFakeTimers({ toFake: ['setImmediate'] })
    try {
      // Not awaited. An async function body runs synchronously up to its first await, so by the
      // time this call returns control here, p1's whole transaction has already run and logged,
      // and the function is suspended on its own `await setImmediate()`, having touched p2 not
      // at all. If that suspension were removed, p2 would already be done too, right here.
      const reportsPromise = rebuildIfNeeded({
        instance: h.instance, nowMs: () => 1, log: (l) => lines.push(l),
      })
      expect(lines.some((l) => l.startsWith('rebuilt p1'))).toBe(true)
      expect(lines.some((l) => l.startsWith('rebuilt p2'))).toBe(false)

      // The one faked timer due resolves the awaited setImmediate(), which is what lets p2 run.
      await vi.advanceTimersByTimeAsync(0)
      expect(lines.some((l) => l.startsWith('rebuilt p2'))).toBe(true)

      // And the loop's own trailing yield after the last person, so the function actually
      // settles rather than leaving a second faked timer stranded.
      await vi.advanceTimersByTimeAsync(0)
      const reports = await reportsPromise
      expect(reports.people.map((r) => r.personId).sort()).toEqual(['p1', 'p2'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runBootSequence', () => {
  test('the sync runner does not start while the rebuild is still running', async () => {
    let resolveRebuild: () => void = () => {}
    const rebuildPromise = new Promise<void>((resolve) => { resolveRebuild = resolve })
      .then(() => ({ people: [], failures: [] }))
    let startSyncCalls = 0

    const sequence = runBootSequence({
      rebuild: () => rebuildPromise,
      startSync: () => { startSyncCalls++ },
      log: () => {},
      logError: () => {},
    })

    // Still pending: nothing has resolved the rebuild yet, so the runner must not have started.
    await Promise.resolve()
    await Promise.resolve()
    expect(startSyncCalls).toBe(0)

    resolveRebuild()
    await sequence

    expect(startSyncCalls).toBe(1)
  })

  test('starts sync when some people were quarantined, and names each of them', async () => {
    let startSyncCalls = 0
    const errors: { message: string, error: unknown }[] = []
    const boom = new Error('incorrect header check')

    await runBootSequence({
      rebuild: () => Promise.resolve({
        people: [],
        failures: [{ personId: 'p1', reasons: ['mapping version unrecorded, now 3'], error: boom }],
      }),
      startSync: () => { startSyncCalls++ },
      log: () => {},
      logError: (message, error) => { errors.push({ message, error }) },
    })

    // The household keeps ingesting. Refusing to start sync for everybody was the safe direction
    // only while a failure was assumed to be structural; once it is one person's, the cost of
    // refusing is every other member losing data that the API will not retain to be re-fetched.
    expect(startSyncCalls).toBe(1)
    // Loudly, through logError rather than log, and one line per person with the error attached.
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('p1')
    expect(errors[0]!.error).toBe(boom)
  })

  test('a failed rebuild does not start the sync runner', async () => {
    let startSyncCalls = 0
    const errors: { message: string, error: unknown }[] = []
    const rebuildError = new Error('rebuild boom')

    await runBootSequence({
      rebuild: () => Promise.reject(rebuildError),
      startSync: () => { startSyncCalls++ },
      log: () => {},
      logError: (message, error) => { errors.push({ message, error }) },
    })

    expect(startSyncCalls).toBe(0)
    expect(errors).toEqual([{ message: 'rebuild failed, sync not started', error: rebuildError }])
  })

  test('the returned promise settles rather than rejecting when the rebuild fails', async () => {
    // This is what makes awaiting it from shutdown safe: a rejected promise nothing has attached
    // a handler to is how a shutdown turns into an unhandled rejection instead of a clean exit.
    await expect(runBootSequence({
      rebuild: () => Promise.reject(new Error('rebuild boom')),
      startSync: () => {},
      log: () => {},
      logError: () => {},
    })).resolves.toBeUndefined()
  })
})
