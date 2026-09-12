/**
 * Runs one caller-supplied SELECT against one throwaway projection file, on its own thread.
 *
 * Its own thread because better-sqlite3 is synchronous and exposes no interrupt: on the main
 * thread a slow query holds the event loop for its whole duration and the instance answers
 * nothing. This does not make the query cancellable - `worker.terminate()` waits for a native call
 * to return, measured at 864ms against a 1195ms query - but it does mean the server keeps serving
 * while one background thread burns.
 *
 * The security boundary is one line below: the caller's SQL reaches `prepare().iterate()` and
 * nothing else. That single choice is what refuses ATTACH (a statement returning no data),
 * multi-statement SQL (the driver refuses), and load_extension (not authorized). Route this
 * string through `.run()` or `.exec()` and every one of those refusals disappears.
 */
import BetterSqlite3 from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'
import { MAX_TEXT } from './contract.ts'

interface SqlWorkerData { projectionPath: string, sql: string, rowCap: number }

const { projectionPath, sql, rowCap } = workerData as SqlWorkerData

const db = new BetterSqlite3(projectionPath, { readonly: true, fileMustExist: true })
try {
  const statement = db.prepare(sql)
  // raw() gives arrays rather than objects: it halves a 500-row payload and keeps the column
  // names in one list the summary walk counts rather than descending into per-row keys.
  const columns = statement.columns().map((c) => c.name)
  const rows: unknown[][] = []
  let truncated = false
  let textTruncated = false
  for (const row of statement.raw().iterate() as IterableIterator<unknown[]>) {
    if (rows.length >= rowCap) { truncated = true; break }
    rows.push(row.map((cell) => {
      if (typeof cell === 'string' && cell.length > MAX_TEXT) {
        textTruncated = true
        return cell.slice(0, MAX_TEXT)
      }
      return cell
    }))
  }
  parentPort!.postMessage({ kind: 'ok', columns, rows, truncated, textTruncated })
} catch (error) {
  // Flattened to plain data rather than posted as-is. structuredClone only special-cases the
  // built-in Error subclasses; better-sqlite3's SqliteError is not among them, so a cloned one
  // arrives with name and message undefined and only its enumerable `code` surviving. This is the
  // same trap rebuildWorker.ts documents and solves the same way.
  const err = error as Error & { code?: string }
  parentPort!.postMessage({
    kind: 'error', name: err.name, message: err.message, code: err.code ?? null,
  })
} finally {
  db.close()
}
