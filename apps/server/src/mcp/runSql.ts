import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ConfigError } from '@haelan/core'

/** Rows, not points: a row here is wider than the series tools' points, where MAX_POINTS is 1000. */
export const SQL_ROW_CAP = 500

/**
 * How long the parent waits before giving up on a query, and - since M4 review Important 3 -
 * genuinely how long the sandbox itself is allowed to run.
 *
 * Under worker_threads this was only ever a caller-side bound: `terminate()` was issued at this
 * point but landed whenever the native call underneath it happened to return, which could be
 * never. Under child_process it is close to a real statement timeout: `child.kill()` measured at
 * single-digit milliseconds to actually end the native call, so this now bounds both how long the
 * caller waits and how long the sandbox burns.
 */
export const SQL_DEADLINE_MS = 5000

/**
 * The child's own V8 heap ceiling - the `child_process` equivalent of a worker's `resourceLimits`,
 * which has no direct counterpart for a forked process. Passed as an `execArgv` flag rather than a
 * constructor option for the same reason `--experimental-strip-types` is: a V8 flag is the only
 * lever `fork()` exposes over the child's own runtime limits.
 *
 * This bounds the child's *JS* heap only - the row loop's accumulated strings and arrays - not
 * SQLite's native allocations, which live outside V8 entirely and are what Important 1's
 * single-step native path (`group_concat(hex(randomblob(...)))` inside one native call) actually
 * grows. That path is bounded by SQL_DEADLINE_MS and a killable child instead, not by this. 256MB
 * is generous next to MAX_RESULT_BYTES's 2MB row budget - room for SQLite's own working set and
 * V8's baseline usage - while still being small enough that a runaway JS-side allocation (a bug
 * here, not a malicious query the row budget already bounds) crashes the child with an
 * out-of-memory error rather than growing toward the multi-gigabyte numbers Important 1 measured.
 */
const CHILD_MAX_OLD_SPACE_MB = 256

export interface SqlResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  textTruncated: boolean
}

interface SqlChildInput { projectionPath: string, sql: string, rowCap: number }

type ChildReply =
  | { kind: 'ok', columns: string[], rows: unknown[][], truncated: boolean, textTruncated: boolean }
  | { kind: 'error', name: string, message: string, code: string | null }

/**
 * One at a time, per instance.
 *
 * A runaway query used to be uninterruptible, so the only thing that bounded the abuse was how
 * many a caller could start; that is still true up to SQL_DEADLINE_MS even now that a runaway one
 * can be killed, because the point a query gets killed for taking too long is already too late to
 * have let a second one start alongside it. Without this the sandbox makes matters *worse* than
 * blocking the event loop did, by removing the natural serialisation that blocking provided: a
 * token holder could start one child per core rather than burning one thread.
 */
let busy = false

/**
 * Translates the driver's own refusals into a sentence that means something to an agent.
 *
 * Two distinct messages arrive for "that is not a SELECT", depending on which call throws first:
 * `columns()` refuses with "The columns() method is only for statements that return data" before
 * iteration begins, while `iterate()` refuses with "This statement does not return data". Both
 * name an internal API the caller cannot reach, so both become the same sentence - which is also
 * the only place this surface says what it *does* allow.
 */
function asAgentError(reply: { message: string }): ConfigError {
  const m = reply.message
  if (/return data|more than one statement/.test(m)) {
    return new ConfigError(
      'sql_query runs exactly one SELECT. It cannot write, attach, or run more than one statement.',
    )
  }
  // Everything else is SQLite's own message about the caller's own SQL: it names tables and
  // columns the caller sent and interpolates nothing this instance holds, which is the rule
  // adapter.ts states for an error reaching an agent as unfiltered prose.
  return new ConfigError(m)
}

export async function runSql(
  input: { projectionPath: string, sql: string, cleanup: () => void },
): Promise<SqlResult> {
  if (busy) {
    // No child was ever started for this call, so nothing else will remove the caller's file.
    input.cleanup()
    throw new ConfigError(
      'another sql_query is already running on this instance. Try again in a moment - a query that '
      + 'timed out may still be finishing.',
    )
  }
  busy = true
  const here = dirname(fileURLToPath(import.meta.url))
  let child: ChildProcess | undefined
  try {
    return await new Promise<SqlResult>((resolve, reject) => {
      child = fork(join(here, 'sqlWorker.ts'), [], {
        // Forked children inherit execArgv by default, which is enough in production where
        // index.ts is started with --experimental-strip-types. It is not always enough under a
        // test runner, whose execArgv is its own business: under vitest 5 it is
        // --experimental-import-meta-resolve, a --require of vitest's warning suppressor and two
        // --conditions, and under vitest 4, when this comment first claimed the list was empty, it
        // was. Neither contains the strip flag, and without it the child would run a .ts file only
        // on a Node that strips types with no flag - which is 23.6 and later, while this repo's
        // floor is 22.14. Passed explicitly rather than relying on a default this repo does not
        // guarantee. The same reasoning, verbatim, as rebuildInWorker.ts.
        execArgv: [
          ...(process.execArgv.includes('--experimental-strip-types')
            ? process.execArgv
            : [...process.execArgv, '--experimental-strip-types']),
          `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`,
        ],
        // The new hazard fork() has that worker_threads never did: stdin/stdout/stderr default to
        // *inherited*, not piped - confirmed by direct measurement, not assumed from the docs -
        // meaning a child left at its defaults writes into the exact same stdout file descriptor
        // this process owns. On the stdio transport that descriptor **is** the JSON-RPC stream,
        // so a stray console.log anywhere the child's import graph reaches (better-sqlite3's own
        // native bindings included) would corrupt every message after it. 'ignore' on stdin,
        // stdout and stderr severs that path completely rather than piping and hoping nothing
        // forwards it - there is nothing here worth reading back from the child's own streams,
        // since every real result crosses the 'ipc' channel below instead.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      const timer = setTimeout(() => {
        // Unlike the worker_threads version, this actually lands close to now rather than
        // whenever a native call happens to return: measured at single-digit milliseconds for
        // child.kill() against a query spinning in the same uninterruptible native call
        // worker.terminate() could only wait out. 'exit' below still does the resolving and the
        // cleanup, for the same reasons it always did.
        child?.kill()
        reject(new ConfigError(
          `that query did not finish within ${SQL_DEADLINE_MS / 1000} seconds. Narrow it - add a WHERE clause, or aggregate over fewer rows.`,
        ))
      }, SQL_DEADLINE_MS)
      timer.unref?.()

      // The reply is stored, not resolved on. Resolution happens at 'exit', below, for the same
      // reason rebuildInWorker.ts does it that way - and here it also closes a race the
      // concurrency limit would otherwise have: releasing `busy` at exit while resolving at
      // message leaves a window in which a caller's own next query is refused as busy,
      // milliseconds after the previous one returned to it.
      let reply: ChildReply | undefined
      child.on('message', (message: ChildReply) => { reply = message })
      // A forked child's own 'error' event is not the equivalent of a worker's: it fires only for
      // a spawn, kill or send failure, never for an uncaught exception in the child's code -
      // sqlWorker.ts now catches everything itself and always sends a reply for exactly that
      // reason. What reaches here is genuinely operational (the child could not be started or
      // signalled), and still wrapped the same way every other refusal is: Node's own message can
      // carry a stack or a module path, and that should not reach an agent unfiltered either.
      child.on('error', (error: Error) => { clearTimeout(timer); reject(asAgentError(error)) })
      // `busy` is released HERE and nowhere else, and that is the whole of the concurrency
      // guarantee. Releasing it when the caller stops waiting would be worse than useless: a
      // timeout rejects while kill() is still landing - measured at single-digit milliseconds,
      // but not zero - so the next caller would start a second child beside the first, exactly in
      // the case the limit exists for.
      child.on('exit', (_code) => {
        busy = false
        clearTimeout(timer)
        // Cleanup lives here, and nowhere else on this path, for the same reason `busy` is
        // released here: the parent names the projection file, so a killed child's file is still
        // reachable after 'exit' fires - but 'exit' is the first moment this side can prove the
        // child's handle on it is actually gone. Calling this earlier - on the timeout rejection,
        // say - would race a native call that has not returned yet; on Windows that race is
        // exactly what turned the caller's ConfigError into an EPERM under worker_threads. Under
        // child_process the same race is measured to close in single-digit milliseconds rather
        // than the 8-10.5 seconds it used to take, but the ordering guarantee - wait for 'exit',
        // then clean up - is unchanged and still the reason this is safe on Windows at all.
        input.cleanup()
        if (reply === undefined) {
          // A killed or crashed child exits with no reply. The timeout path has already rejected
          // by then, and a second rejection on a settled promise is a no-op; this covers a child
          // that ended some other way (a crash past CHILD_MAX_OLD_SPACE_MB, say).
          reject(new ConfigError('the query was stopped before it finished.'))
        } else if (reply.kind === 'ok') {
          resolve({
            columns: reply.columns, rows: reply.rows,
            truncated: reply.truncated, textTruncated: reply.textTruncated,
          })
        } else {
          reject(asAgentError(reply))
        }
      })

      // Sent only once the handlers above are wired up. A fork()'d child has no constructor-time
      // data option the way `new Worker(path, { workerData })` did, so the payload crosses the
      // same 'ipc' channel the reply later comes back on - sent immediately, well before the
      // child has actually started, let alone attached its own listener. Confirmed safe by direct
      // measurement rather than assumed: three runs, zero drops. sqlWorker.ts's module body is
      // synchronous from its first import to its `process.once('message', ...)` call, and Node
      // cannot deliver a queued IPC message to that listener before that synchronous run
      // completes and control returns to the child's own event loop - so the ordering here is
      // guaranteed by how Node schedules I/O, not by luck.
      const payload: SqlChildInput = {
        projectionPath: input.projectionPath, sql: input.sql, rowCap: SQL_ROW_CAP,
      }
      child.send(payload)
    })
  } catch (error) {
    // The child never started, so nothing will ever fire 'exit' to release the flag - or to
    // remove the caller's file, which is why this path removes it itself.
    if (child === undefined) {
      busy = false
      input.cleanup()
    }
    throw error
  }
}

/**
 * A directory for one query's projection, and its removal.
 *
 * The *parent* owns the path because a killed child leaves its file behind, so cleanup has to be
 * reachable from the side that survives. `rmSync` never sits in a `finally` around an assertion -
 * this repo has been bitten eight times by an EPERM from an open handle replacing the real error -
 * so callers remove it explicitly after the result is in hand.
 *
 * `remove()` itself never throws. A projection is a throwaway file in a throwaway temp directory;
 * failing to delete one is never worth surfacing, and on Windows a still-open handle (a killed
 * child's native call has not actually returned yet) makes `rmSync` throw `EPERM` - which is
 * exactly the failure this design exists to keep off the caller. The directory is simply leaked in
 * that case, same as the OS temp directory is cleaned up eventually regardless. That window is now
 * measured in single-digit milliseconds rather than seconds (see sql-sandbox-deadline-cleanup.test.ts),
 * but it is not zero, so this guard stays.
 */
export function makeProjectionDir(): { path: string, remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-sql-'))
  return {
    path: join(dir, 'projection.db'),
    remove: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Swallowed deliberately - see the doc comment above.
      }
    },
  }
}
