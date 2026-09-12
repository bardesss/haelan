/**
 * Runs one caller-supplied SELECT against one throwaway projection file, on its own thread.
 *
 * Its own thread because better-sqlite3 is synchronous and exposes no interrupt: on the main
 * thread a slow query holds the event loop for its whole duration and the instance answers
 * nothing. This does not make the query cancellable - `worker.terminate()` waits for a native call
 * to return, measured at 864ms against a 1195ms query - but it does mean the server keeps serving
 * while one background thread burns.
 *
 * The security boundary is **two** mechanisms, not one, and each covers what the other misses:
 *
 * 1. **The caller's SQL reaches `prepare().iterate()` and nothing else.** That refuses ATTACH (a
 *    statement returning no data, caught by `columns()`/`iterate()`), multi-statement SQL (the
 *    driver refuses more than one statement) and `load_extension` (not authorized). It does
 *    *not* refuse `VACUUM INTO '<path>'` - also a statement that returns no data, so this leg
 *    catches that one too, but for a different reason: VACUUM INTO is a filesystem-write
 *    primitive, and `readonly` below plays no part in stopping it.
 * 2. **The connection below is opened `readonly: true`.** This is the leg that refuses
 *    `INSERT INTO … RETURNING *`: it returns rows, so `iterate()` runs it exactly like a SELECT -
 *    `readonly: true` is the *only* thing that refuses it. Drop it because it looks redundant
 *    beside `fileMustExist`, and every existing test still passes while the caller's SQL could
 *    write.
 *
 * Neither mechanism alone is the boundary; both are, and `sql-sandbox.test.ts`'s `RETURNING *`
 * and `VACUUM INTO` cases each pin the leg the other cannot.
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
      // Checked before the string branch, and checked at all only because of a measurement: a
      // BLOB comes back from better-sqlite3 as a Buffer, which is a Uint8Array and not a string,
      // so it would otherwise pass through every bound below untouched. `WITH RECURSIVE c(x) AS
      // (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT randomblob(1000000) FROM c` returns 500 rows
      // - inside the row cap - in 1209ms - inside the 5-second deadline - and those rows hold
      // 500,000,000 bytes. That is already large enough that `structuredClone`-ing it to the
      // parent (another 500MB) and then `JSON.stringify`-ing it in adapter.ts throws `RangeError:
      // Invalid string length`; at `randomblob(10000000)` it is 5GB and the container is
      // OOM-killed, which takes the instance down for every member, not just the caller. A Buffer
      // is meaningless to an agent reading JSON anyway, and no projection column holds a binary
      // value, so nothing legitimate is lost by replacing it with a placeholder here.
      if (cell instanceof Uint8Array) { textTruncated = true; return `<${cell.length} bytes>` }
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
