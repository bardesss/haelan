import { parentPort, threadId, workerData } from 'node:worker_threads'
import { openHaelan } from '@haelan/core'
import { rebuildIfNeeded } from './rebuild.ts'
// The other half of the pair lives with its inverse rather than beside its caller: the two only
// mean anything together, and a test can reach them there (rebuildWorker.ts is a worker entry
// point, so importing it runs it).
import { toSerializableFailure } from './rebuildInWorker.ts'

// A better-sqlite3 handle cannot cross a thread boundary, so the worker receives the directory and
// opens the same file itself. WAL lets this connection hold a write transaction while the main
// thread keeps reading (see packages/core/src/db/open.ts, journal_mode = WAL).
const { dataDir } = workerData as { dataDir: string }
const instance = openHaelan(dataDir)

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
