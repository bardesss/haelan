import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PeopleStore, peopleNeedingRebuild } from '@haelan/core'
import type { Instance } from '@haelan/core'
import type { RebuildFailure } from './rebuild.ts'

/** What crosses the IPC channel on the way out: the one thing the child needs to do its work. */
export interface ChildInput { dataDir: string }

/** What rebuildWorker.ts actually sends: failures with their error flattened to plain data, since
 * that is the part the channel cannot be trusted with (see toSerializableFailure below). */
export interface SerializedFailure {
  personId: string
  reasons: string[]
  error: { name: string, message: string, stack?: string, [extra: string]: unknown }
}

export type ChildMessage =
  | { kind: 'log', line: string }
  | { kind: 'done', failures: readonly SerializedFailure[], pid: number }
  | { kind: 'fatal', error: { name: string, message: string, stack?: string } }

// A forked child's IPC channel serialises with JSON.stringify (child_process's default
// `serialization: 'json'`), and `name`, `message` and `stack` are non-enumerable own properties of
// an Error, so JSON.stringify drops all three while a plain enumerable property like
// better-sqlite3's `code` survives. A failure sent unflattened therefore arrives as `{"code":...}`
// with nothing an operator can read, and runBootSequence interpolates `failure.error.message` into
// the line naming the quarantined person - so it would say somebody could not be rebuilt because
// of undefined.
//
// The thread version of this file needed the same flattening for a different mechanism:
// postMessage uses structuredClone, which copies message and stack only out of the built-in Error
// subclasses, and better-sqlite3's SqliteError is not one of those. Different transport, same
// symptom, same fix - pull the fields out by hand before they cross. Both directions are checked
// against a real SqliteError in test/rebuild-worker.test.ts.
export function toSerializableFailure(failure: RebuildFailure): SerializedFailure {
  const { error, ...rest } = failure
  const { name, message, stack } = error
  const extra = Object.fromEntries(
    Object.entries(error).filter(([key]) => key !== 'name' && key !== 'message' && key !== 'stack'),
  )
  return { ...rest, error: { name, message, stack, ...extra } }
}

// The inverse: turns the plain data that crossed the process boundary back into a real Error,
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
 * Runs the rebuild in another process so this one keeps serving.
 *
 * One person's rebuild is a synchronous loop over their days (runRebuild.ts has no awaits at all),
 * so it holds Node's only thread from the first day to the last and the server answers nothing for
 * as long as that takes. rebuildIfNeeded's `await setImmediate()` does open a gap, but only after a
 * person's transaction has already returned, so it buys nothing at all for a household of one,
 * which is the case that reported this and the case a self hosted dashboard mostly is. index.ts
 * has always run the rebuild after listen, meaning to keep the server answering; this is what
 * makes that intent true however many people there are.
 *
 * A child process rather than a worker thread. rebuildWorker.ts's own header carries the whole
 * reason, which is a V8 WebAssembly crash that repeated thread spawns were tripping; the short
 * version is that the rebuild never needed to share memory with this process, and a process
 * boundary is the one that does not share V8's WebAssembly code registry either.
 *
 * Rejects when the child fails or exits non zero, so runBootSequence's catch reports it and
 * shutdown never waits on a promise that will not settle.
 */
export function rebuildInWorker(
  opts: { dataDir: string, log: (line: string) => void },
): Promise<{ failures: readonly RebuildFailure[], pid: number }> {
  const here = dirname(fileURLToPath(import.meta.url))
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(join(here, 'rebuildWorker.ts'), [], {
      // Forked children inherit execArgv by default, which is enough in production, where
      // index.ts itself is started with --experimental-strip-types. It is not always enough under
      // a test runner, whose execArgv is its own business: under vitest 5 it is
      // --experimental-import-meta-resolve, a --require of vitest's warning suppressor and two
      // --conditions, and under vitest 4 it was empty. Neither contains the strip flag, and
      // without it the child runs a .ts file only on a Node that strips types with no flag at all
      // - which is 23.6 and later, while this repo's declared floor is 22.13. So it is passed
      // explicitly rather than relying on a default this repo does not guarantee.
      execArgv: process.execArgv.includes('--experimental-strip-types')
        ? process.execArgv
        : [...process.execArgv, '--experimental-strip-types'],
      // The hazard fork() has that worker_threads never did: stdin/stdout/stderr default to
      // *inherited*, not piped, so a child left at its defaults writes into the exact same stdout
      // file descriptor this process owns. On the MCP stdio transport that descriptor **is** the
      // JSON-RPC stream, so a stray write anywhere the child's import graph reaches would corrupt
      // every message after it. Nothing here is worth reading back from the child's own streams:
      // every line the operator sees crosses the 'ipc' channel below instead, and so does every
      // failure, because rebuildWorker.ts catches its own.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })

    let outcome: { failures: readonly RebuildFailure[], pid: number } | undefined
    let fatal: Error | undefined

    child.on('message', (message: ChildMessage) => {
      if (message.kind === 'log') opts.log(message.line)
      else if (message.kind === 'done') {
        outcome = { failures: message.failures.map(reviveFailure), pid: message.pid }
      } else {
        const error = new Error(message.error.message)
        error.name = message.error.name
        if (message.error.stack !== undefined) error.stack = message.error.stack
        fatal = error
      }
    })
    // A forked child's own 'error' event is not the equivalent of a worker's: it fires only for a
    // spawn, kill or send failure, never for an uncaught exception in the child's code. What
    // reaches here is genuinely operational - the child could not be started or signalled.
    child.on('error', reject)
    // Settled here and nowhere else, which is what index.ts's shutdown ordering rests on: it
    // awaits this promise before closing SQLite, precisely so it does not close under the child's
    // write transaction, and 'exit' is the first moment this side can prove the child's handle on
    // the file is actually gone.
    child.on('exit', (code) => {
      if (fatal !== undefined) reject(fatal)
      else if (code !== 0) reject(new Error(`rebuild worker exited with code ${code}`))
      // A zero exit with no done message means the child ended without reporting, which is a
      // failure to report rather than a rebuild with nothing to say.
      else if (outcome === undefined) reject(new Error('rebuild worker exited without reporting'))
      else resolve(outcome)
    })

    // Sent only once the handlers above are wired up, and before the child has plausibly started:
    // a send() issued this early is queued rather than dropped, which is the same ordering
    // runSql.ts relies on and rebuildWorker.ts's own comment describes from the other side.
    child.send({ dataDir: opts.dataDir } satisfies ChildInput)
  })
}

/**
 * The same thing, but only when somebody actually needs rebuilding.
 *
 * Spawning is not free and it is not safe. A process spawn, a second type strip and a second
 * better-sqlite3 load cost seconds of every boot - measured at 4 to 5 on Linux, nearly all of it
 * type stripping - and the boot that needs none of it is the overwhelmingly common one: a rebuild
 * is wanted after a version bump, not after a restart. The cost that matters more is the failure
 * class. If the child cannot start, rebuildInWorker rejects, runBootSequence catches, and sync
 * never starts for anybody, so an ordinary boot that had no work to do would have gained a way to
 * leave the whole household not ingesting.
 *
 * The check itself is the same query rebuildIfNeeded opens with, and it is cheap: one read of the
 * people table on a connection this process already holds. Running it twice, once here and once
 * inside the child, is deliberate. This one decides whether to spawn; the child's own is what
 * actually drives the rebuild, and it stays the authority on that.
 *
 * pid is null exactly when no child was started, which is what a test can hold this against.
 */
export async function rebuildInWorkerIfNeeded(
  opts: { instance: Instance, dataDir: string, log: (line: string) => void },
): Promise<{ failures: readonly RebuildFailure[], pid: number | null }> {
  const needs = peopleNeedingRebuild(new PeopleStore(opts.instance.db).list())
  if (needs.length === 0) return { failures: [], pid: null }
  return rebuildInWorker({ dataDir: opts.dataDir, log: opts.log })
}
