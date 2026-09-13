/**
 * Runs the boot rebuild off the main thread, in its own child process.
 *
 * Its own *process*, not a thread, and the reason is a crash rather than a preference. As a
 * `worker_threads` entry point this file was a `.ts` file loaded by a real Node worker, so every
 * spawn made that worker compile and instantiate Amaro - Node's TypeScript stripper, which is SWC
 * compiled to WebAssembly (`process.config.variables.node_use_amaro`) - inside its own isolate,
 * and every exit made V8 free that dead WebAssembly code through the `WasmEngine` it shares across
 * every isolate in the process. v1.14.1's publish job died of exactly that: one SIGSEGV, 302 test
 * files green, no stack. Cored on Linux, the faulting frame was
 * `ThreadIsolation::UnregisterWasmAllocation`, reached through `WasmImportWrapperCache::Free` from
 * `WasmEngine::FreeDeadCode`, with seven of eleven threads inside V8's WebAssembly or JIT
 * registries at once and `better_sqlite3.node` not even mapped into the process. The bug is V8's,
 * not this repository's, but the trigger was ours: repeatedly creating and destroying threads that
 * each instantiate the same WebAssembly module.
 *
 * A forked process has its own `WasmEngine`, so there is no shared registry to disagree with
 * itself and nothing to free across isolates. It also costs almost nothing here that the thread
 * did not already cost: measured on Linux, a worker importing `@haelan/core` takes about 4-5
 * seconds whichever way it starts, because that time is the type stripping, not the spawn.
 *
 * This is the second place in this repository to make that move; `mcp/sqlWorker.ts` went first,
 * for an unrelated reason (a forked child can actually be killed mid-query), and everything below
 * follows the shape it settled on.
 *
 * Everything runs inside one `try`, opening the database included, and that is the difference from
 * the thread version that matters most. A worker thread that threw uncaught fired the parent's
 * `worker.on('error')`, which is where `rebuildInWorker` used to learn why a worker could not
 * start. A forked child has no equivalent: `ChildProcess`'s own `'error'` fires only for a spawn,
 * kill or send failure, never for an uncaught throw in the child's code, so an uncaught throw here
 * would reach the parent as a bare exit code and the operator would be told a number instead of a
 * reason. Catching everything and always replying keeps that failure as legible as the rest.
 */
import { openHaelan } from '@haelan/core'
import { rebuildIfNeeded } from './rebuild.ts'
// The other half of the pair lives with its inverse rather than beside its caller: the two only
// mean anything together, and a test can reach them there (this file is a child entry point, so
// importing it runs it).
import { toSerializableFailure } from './rebuildInWorker.ts'
import type { ChildInput, ChildMessage } from './rebuildInWorker.ts'

// A thread died with the process that made it. A forked child does not, and that is the one thing
// the process boundary takes away rather than gives: a server killed mid rebuild used to take its
// rebuild down with it, and this one outlives its parent.
//
// It does not outlive it for long, and the bound is here rather than in a signal handler: the next
// line this rebuild reports is the next time it tries to reach a parent that is gone, and that is
// where it ends.
//
// Both halves of that are needed, and the second only became obvious by measurement. `connected`
// catches a disconnect this process has already observed. It does not catch the common case, where
// the write is what discovers the parent is gone: the failure arrives asynchronously, as an
// 'error' event on the channel with nobody listening - EPIPE on Windows, ERR_IPC_CHANNEL_CLOSED
// elsewhere - which Node turns into a crash with a stack trace. So an orphan whose parent merely
// shut down would leave a crash behind for an operator to find and wonder about. Passing a
// callback to send() is what routes that error here instead of to a crash, and exiting
// deliberately - non zero, because the job genuinely did not finish - says the true thing quietly.
//
// What this cannot bound, and nothing here can, is the inside of one person's rebuild: it is a
// single synchronous transaction with no logging and no yields, measured at fifteen minutes on
// real data, and an orphan is unreachable for the whole of it. That is not a regression - the
// thread version had the identical bound, because terminate() also only landed when the native
// call underneath it returned - but it is the reason this is a bound and not a guarantee. The
// transaction is never committed, so the next open rolls it back and the file is sound regardless.
//
// In the shipped container none of this is reachable anyway: the runtime kills every process in
// the container when PID 1 dies. It is a bare `node` run or a dev session that can orphan one.
function send(message: ChildMessage): void {
  if (!process.connected) process.exit(1)
  // Present on every process started with fork(), which always wires up the ipc channel, so this
  // is the child_process equivalent of the old `parentPort?.postMessage` - and an assertion
  // rather than an optional call for the same reason sqlWorker.ts makes one: it is only ever
  // undefined in a process that was not started the way this one always is.
  process.send!(message, (error: Error | null) => { if (error !== null) process.exit(1) })
}

// The payload arrives over the fork's own IPC channel rather than as workerData, since
// child_process has no constructor-time data option the way `new Worker(path, { workerData })`
// had. rebuildInWorker.ts sends it immediately after fork() returns, before this listener could
// plausibly have missed it: a send() issued before the child's own listener attaches is queued,
// not dropped, and this module body is synchronous from its first import to the `once` below, so
// Node cannot deliver to that listener until the body has finished running.
process.once('message', (input: ChildInput) => {
  void (async () => {
    try {
      // A better-sqlite3 handle cannot cross a process boundary any more than it could cross a
      // thread one, so the child receives the directory and opens the same file itself. WAL lets
      // this connection hold a write transaction while the parent keeps reading (see
      // packages/core/src/db/open.ts, journal_mode = WAL).
      const instance = openHaelan(input.dataDir)
      try {
        const report = await rebuildIfNeeded({
          instance,
          nowMs: Date.now,
          // Sent rather than written, so the parent owns every line the operator sees and the
          // ordering with its own logs is real rather than two processes racing for stdout. It
          // also has to be sent: rebuildInWorker.ts starts this child with its stdio ignored,
          // because on the MCP stdio transport the parent's stdout is the JSON-RPC stream.
          log: (line) => { send({ kind: 'log', line }) },
        })
        send({
          kind: 'done',
          failures: report.failures.map(toSerializableFailure),
          // The one observable that tells rebuildInWorker's caller this ran somewhere else rather
          // than racing a timer against a rebuild that might finish before anything could measure
          // it. A pid where the thread version reported a thread id, and a stronger claim than
          // that one was: a test can compare it against its own `process.pid`.
          pid: process.pid,
        })
      } finally {
        instance.close()
      }
    } catch (error) {
      // Flattened by hand, for the same reason every failure below `done` is - see
      // toSerializableFailure in rebuildInWorker.ts. This is the path that used to be
      // `worker.on('error')`.
      const err = error as Error
      send({ kind: 'fatal', error: { name: err.name, message: err.message, stack: err.stack } })
      process.exitCode = 1
    }
  })()
})
