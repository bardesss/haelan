import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ConfigError } from '@haelan/core'

/** Rows, not points: a row here is wider than the series tools' points, where MAX_POINTS is 1000. */
export const SQL_ROW_CAP = 500

/**
 * How long the parent waits before giving up on a query.
 *
 * Not a statement timeout, because there is no such thing here: `terminate()` is issued at this
 * point and lands whenever the native call returns. What this bounds is how long the *caller*
 * waits, not how long the thread burns.
 */
export const SQL_DEADLINE_MS = 5000

export interface SqlResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  textTruncated: boolean
}

type WorkerReply =
  | { kind: 'ok', columns: string[], rows: unknown[][], truncated: boolean, textTruncated: boolean }
  | { kind: 'error', name: string, message: string, code: string | null }

/**
 * One at a time, per instance.
 *
 * A runaway query cannot be killed, so the only thing that bounds the abuse is how many a caller
 * can start. Without this the worker makes matters *worse* than blocking the event loop did, by
 * removing the natural serialisation that blocking provided: a token holder could pin every core
 * rather than one thread.
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
    // No worker was ever opened for this call, so nothing else will remove the caller's file.
    input.cleanup()
    throw new ConfigError(
      'another sql_query is already running on this instance. Try again in a moment - a query that '
      + 'timed out may still be finishing.',
    )
  }
  busy = true
  const here = dirname(fileURLToPath(import.meta.url))
  let worker: Worker | undefined
  try {
    return await new Promise<SqlResult>((resolve, reject) => {
      worker = new Worker(join(here, 'sqlWorker.ts'), {
        workerData: { projectionPath: input.projectionPath, sql: input.sql, rowCap: SQL_ROW_CAP },
        // Workers inherit execArgv by default, which is enough in production where index.ts is
        // started with --experimental-strip-types. It is not enough under vitest: that process has
        // an empty execArgv, and the worker would still run a .ts file only on a Node that strips
        // types with no flag - which is 23.6 and later, while this repo's floor is 22.13. Passed
        // explicitly rather than relying on a default this repo does not guarantee. The same
        // reasoning, verbatim, as rebuildInWorker.ts.
        execArgv: process.execArgv.includes('--experimental-strip-types')
          ? process.execArgv
          : [...process.execArgv, '--experimental-strip-types'],
      })
      const timer = setTimeout(() => {
        // terminate() will land when the native call returns, not now. The caller stops waiting
        // either way, which is what the deadline is for.
        void worker?.terminate()
        reject(new ConfigError(
          `that query did not finish within ${SQL_DEADLINE_MS / 1000} seconds. Narrow it - add a WHERE clause, or aggregate over fewer rows.`,
        ))
      }, SQL_DEADLINE_MS)
      timer.unref?.()

      // The reply is stored, not resolved on. Resolution happens at 'exit', below, for the same
      // reason rebuildInWorker.ts does it that way - and here it also closes a race the concurrency
      // limit would otherwise have: releasing `busy` at exit while resolving at message leaves a
      // window in which a caller's own next query is refused as busy, milliseconds after the
      // previous one returned to it.
      let reply: WorkerReply | undefined
      worker.on('message', (message: WorkerReply) => { reply = message })
      worker.on('error', (error) => { clearTimeout(timer); reject(error) })
      // `busy` is released HERE and nowhere else, and that is the whole of the concurrency
      // guarantee. Releasing it when the caller stops waiting would be worse than useless: a
      // timeout rejects while the thread is still burning - terminate() lands only when the native
      // call returns - so the next caller would start a second thread beside the first, exactly in
      // the case the limit exists for. One runaway would become as many as somebody cared to ask
      // for.
      worker.on('exit', (code) => {
        busy = false
        clearTimeout(timer)
        // Cleanup lives here, and nowhere else on this path, for the same reason `busy` is
        // released here: the parent names the projection file, so a terminated worker's file is
        // still reachable after 'exit' fires - but 'exit' is the first moment this side can prove
        // the worker's handle on it is actually gone. Calling this earlier - on the timeout
        // rejection, say - races a native call that has not returned yet; on Windows that race is
        // exactly what turned the caller's ConfigError into an EPERM.
        input.cleanup()
        if (reply === undefined) {
          // A terminated worker exits with no reply. The timeout path has already rejected by
          // then, and a second rejection on a settled promise is a no-op; this covers the worker
          // that died for some other reason.
          reject(new ConfigError('the query was stopped before it finished.'))
        } else if (reply.kind === 'ok') {
          resolve({
            columns: reply.columns, rows: reply.rows,
            truncated: reply.truncated, textTruncated: reply.textTruncated,
          })
        } else {
          reject(asAgentError(reply))
        }
        void code
      })
    })
  } catch (error) {
    // The worker never started, so nothing will ever fire 'exit' to release the flag - or to
    // remove the caller's file, which is why this path removes it itself.
    if (worker === undefined) {
      busy = false
      input.cleanup()
    }
    throw error
  }
}

/**
 * A directory for one query's projection, and its removal.
 *
 * The *parent* owns the path because a terminated worker leaves its file behind, so cleanup has to
 * be reachable from the side that survives. `rmSync` never sits in a `finally` around an
 * assertion - this repo has been bitten eight times by an EPERM from an open handle replacing the
 * real error - so callers remove it explicitly after the result is in hand.
 *
 * `remove()` itself never throws. A projection is a throwaway file in a throwaway temp directory;
 * failing to delete one is never worth surfacing, and on Windows a still-open handle (a terminated
 * worker's native call has not actually returned yet) makes `rmSync` throw `EPERM` - which is
 * exactly the failure this design exists to keep off the caller. The directory is simply leaked in
 * that case, same as the OS temp directory is cleaned up eventually regardless.
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
