import { parentPort, threadId, workerData } from 'node:worker_threads'
import { openHaelan } from '@haelan/core'
import { rebuildIfNeeded } from './rebuild.ts'
import type { RebuildFailure } from './rebuild.ts'

// A better-sqlite3 handle cannot cross a thread boundary, so the worker receives the directory and
// opens the same file itself. WAL lets this connection hold a write transaction while the main
// thread keeps reading (see packages/core/src/db/open.ts, journal_mode = WAL).
const { dataDir } = workerData as { dataDir: string }
const instance = openHaelan(dataDir)

// structuredClone, which postMessage uses, only special cases the built in Error subclasses
// (Error, TypeError, RangeError and the like): message and stack are copied out of those
// directly, even though both are non enumerable. Anything else with Error in its prototype chain
// falls through to the generic object path, which copies only own enumerable properties. Checked
// directly against better-sqlite3's SqliteError, the error a rebuild is most likely to throw: it
// is not on the recognised list, so a cloned one arrives with name and message undefined and only
// its enumerable `code` surviving. A failure is therefore flattened to plain data before posting
// and rebuilt into a real Error in rebuildInWorker, where runBootSequence's logError expects one.
function toSerializableFailure(failure: RebuildFailure) {
  const { error, ...rest } = failure
  const { name, message, stack } = error
  const extra = Object.fromEntries(
    Object.entries(error).filter(([key]) => key !== 'name' && key !== 'message' && key !== 'stack'),
  )
  return { ...rest, error: { name, message, stack, ...extra } }
}

try {
  const report = await rebuildIfNeeded({
    instance,
    nowMs: Date.now,
    // Posted rather than written, so the main thread owns every line the operator sees and the
    // ordering with its own logs is real rather than two threads racing for stdout.
    log: (line) => { parentPort?.postMessage({ kind: 'log', line }) },
  })
  parentPort?.postMessage({
    kind: 'done',
    failures: report.failures.map(toSerializableFailure),
    // The one observable that tells rebuildInWorker's caller this ran off the main thread rather
    // than racing a timer against a rebuild that might finish before anything could measure it.
    threadId,
  })
} finally {
  instance.close()
}
