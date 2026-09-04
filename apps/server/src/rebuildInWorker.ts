import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RebuildFailure } from './rebuild.ts'

/** What rebuildWorker.ts actually posts: failures with their error flattened to plain data, since
 * that is the part structured clone cannot be trusted with (see rebuildWorker.ts). */
interface SerializedFailure {
  personId: string
  reasons: string[]
  error: { name: string, message: string, stack?: string, [extra: string]: unknown }
}

type WorkerMessage =
  | { kind: 'log', line: string }
  | { kind: 'done', failures: readonly SerializedFailure[], threadId: number }

// The inverse of rebuildWorker.ts's toSerializableFailure: turns the plain data that crossed the
// thread boundary back into a real Error, which is what RebuildFailure promises its callers and
// what runBootSequence hands to logError.
function reviveFailure(failure: SerializedFailure): RebuildFailure {
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
 * The rebuild is a synchronous loop over people and days (runRebuild.ts has no awaits at all), so
 * called directly it blocks the event loop for its whole duration and the server answers nothing.
 * index.ts has always run it after listen, meaning to avoid exactly that; this is what makes that
 * intent true.
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
