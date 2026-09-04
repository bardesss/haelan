import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PeopleStore, peopleNeedingRebuild } from '@haelan/core'
import type { Instance } from '@haelan/core'
import type { RebuildFailure } from './rebuild.ts'

/** What rebuildWorker.ts actually posts: failures with their error flattened to plain data, since
 * that is the part structured clone cannot be trusted with (see toSerializableFailure below). */
export interface SerializedFailure {
  personId: string
  reasons: string[]
  error: { name: string, message: string, stack?: string, [extra: string]: unknown }
}

type WorkerMessage =
  | { kind: 'log', line: string }
  | { kind: 'done', failures: readonly SerializedFailure[], threadId: number }

// structuredClone, which postMessage uses, only special cases the built in Error subclasses
// (Error, TypeError, RangeError and the like): message and stack are copied out of those
// directly, even though both are non enumerable. Anything else with Error in its prototype chain
// falls through to the generic object path, which copies only own enumerable properties. Checked
// directly against better-sqlite3's SqliteError, the error a rebuild is most likely to throw: it
// is not on the recognised list, so a cloned one arrives with name and message undefined and only
// its enumerable `code` surviving. A failure is therefore flattened to plain data before posting
// and rebuilt into a real Error by reviveFailure below, where runBootSequence's logError expects
// one. Both directions are checked against a real SqliteError in test/rebuild-worker.test.ts.
export function toSerializableFailure(failure: RebuildFailure): SerializedFailure {
  const { error, ...rest } = failure
  const { name, message, stack } = error
  const extra = Object.fromEntries(
    Object.entries(error).filter(([key]) => key !== 'name' && key !== 'message' && key !== 'stack'),
  )
  return { ...rest, error: { name, message, stack, ...extra } }
}

// The inverse: turns the plain data that crossed the thread boundary back into a real Error,
// which is what RebuildFailure promises its callers and what runBootSequence hands to logError.
export function reviveFailure(failure: SerializedFailure): RebuildFailure {
  const { error, ...rest } = failure
  const revived = new Error(error.message)
  revived.name = error.name
  if (error.stack !== undefined) revived.stack = error.stack
  for (const [key, value] of Object.entries(error)) {
    if (key !== 'name' && key !== 'message' && key !== 'stack') {
      Object.assign(revived, { [key]: value })
    }
  }
  return { ...rest, error: revived }
}

/**
 * Runs the rebuild on another thread so the main one keeps serving.
 *
 * One person's rebuild is a synchronous loop over their days (runRebuild.ts has no awaits at all),
 * so it holds the event loop from the first day to the last and the server answers nothing for as
 * long as that takes. rebuildIfNeeded's `await setImmediate()` does open a gap, but only after a
 * person's transaction has already returned, so it buys nothing at all for a household of one,
 * which is the case that reported this and the case a self hosted dashboard mostly is. index.ts
 * has always run the rebuild after listen, meaning to keep the server answering; this is what
 * makes that intent true however many people there are.
 *
 * Rejects when the worker fails or exits non zero, so runBootSequence's catch reports it and
 * shutdown never waits on a promise that will not settle.
 */
export function rebuildInWorker(
  opts: { dataDir: string, log: (line: string) => void },
): Promise<{ failures: readonly RebuildFailure[], threadId: number }> {
  const here = dirname(fileURLToPath(import.meta.url))
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(here, 'rebuildWorker.ts'), {
      workerData: { dataDir: opts.dataDir },
      // Workers inherit execArgv by default, which is enough in production, where index.ts
      // itself is started with --experimental-strip-types. It is not enough under vitest: that
      // process has an empty execArgv (it transforms TypeScript itself rather than asking Node
      // to), confirmed by printing it here, and the worker still ran a .ts file only because this
      // machine's Node (26) strips types by default with no flag at all. That default did not
      // exist before Node 23.6, and this repo's declared floor is 22.13, so the flag is passed
      // explicitly rather than relying on a default this repo does not guarantee.
      execArgv: process.execArgv.includes('--experimental-strip-types')
        ? process.execArgv
        : [...process.execArgv, '--experimental-strip-types'],
    })
    let outcome: { failures: readonly RebuildFailure[], threadId: number } | undefined

    worker.on('message', (message: WorkerMessage) => {
      if (message.kind === 'log') opts.log(message.line)
      else outcome = { failures: message.failures.map(reviveFailure), threadId: message.threadId }
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`rebuild worker exited with code ${code}`))
      // A zero exit with no done message means the worker ended without reporting, which is a
      // failure to report rather than a rebuild with nothing to say.
      else if (outcome === undefined) reject(new Error('rebuild worker exited without reporting'))
      else resolve(outcome)
    })
  })
}

/**
 * The same thing, but only when somebody actually needs rebuilding.
 *
 * Spawning is not free and it is not safe. A thread spawn, a second type strip and a second
 * better-sqlite3 load cost about a second of every boot, and the boot that needs none of it is
 * the overwhelmingly common one: a rebuild is wanted after a version bump, not after a restart.
 * The cost that matters more is the failure class. If the worker cannot start, rebuildInWorker
 * rejects, runBootSequence catches, and sync never starts for anybody, so an ordinary boot that
 * had no work to do would have gained a way to leave the whole household not ingesting.
 *
 * The check itself is the same query rebuildIfNeeded opens with, and it is cheap: one read of the
 * people table on a connection this thread already holds. Running it twice, once here and once
 * inside the worker, is deliberate. This one decides whether to spawn; the worker's own is what
 * actually drives the rebuild, and it stays the authority on that.
 *
 * threadId is null exactly when no worker was started, which is what a test can hold this against.
 */
export async function rebuildInWorkerIfNeeded(
  opts: { instance: Instance, dataDir: string, log: (line: string) => void },
): Promise<{ failures: readonly RebuildFailure[], threadId: number | null }> {
  const needs = peopleNeedingRebuild(new PeopleStore(opts.instance.db).list())
  if (needs.length === 0) return { failures: [], threadId: null }
  return rebuildInWorker({ dataDir: opts.dataDir, log: opts.log })
}
