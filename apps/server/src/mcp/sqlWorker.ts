/**
 * Runs one caller-supplied SELECT against one throwaway projection file, in its own child process.
 *
 * Its own *process*, not a thread. better-sqlite3 is synchronous and exposes no interrupt, and
 * that has a consequence the M4b spec accepted without measuring it: on a worker thread,
 * `worker.terminate()` still waits for the native call underneath it to return - measured at
 * 864ms against a 1195ms query, and unboundedly worse against a query with no natural end, because
 * threads share one process and Node cannot reclaim memory a native call is still touching out
 * from under it. None of that is true of a process. Measured (see runSql.ts): `child.kill()`
 * against a query spinning inside the same uninterruptible native call exits in single-digit
 * milliseconds, because the OS - not V8 - is doing the reclaiming. That is the whole reason this
 * file is a `child_process.fork()` entry point rather than a `worker_threads` one: the query
 * itself is exactly as uninterruptible either way, but only one of the two lets the caller stop
 * waiting on it for real.
 *
 * The security boundary is unchanged from the thread version, and still **two** mechanisms, not
 * one - each covers what the other misses:
 *
 * 1. **The caller's SQL reaches `prepare().iterate()` and nothing else.** That refuses ATTACH (a
 *    statement returning no data, caught by `columns()`/`iterate()`), multi-statement SQL (the
 *    driver refuses more than one statement) and `load_extension` (not authorized). It does
 *    *not* refuse `VACUUM INTO '<path>'` - also a statement that returns no data, so this leg
 *    catches that one too, but for a different reason: VACUUM INTO is a filesystem-write
 *    primitive, and `readonly` below plays no part in stopping it.
 * 2. **The connection below is opened `readonly: true`.** This is the leg that refuses
 *    `INSERT INTO … RETURNING *`: it returns rows, so `iterate()` runs it exactly like a SELECT -
 *    `readonly: true` is the *only* thing that refuses it.
 *
 * Neither mechanism alone is the boundary; both are, and `sql-sandbox.test.ts`'s `RETURNING *`
 * and `VACUUM INTO` cases each pin the leg the other cannot.
 *
 * Everything below - including opening the database - runs inside one `try`, and that is a
 * deliberate difference from the thread version this replaces. A worker thread that throws
 * uncaught fires the parent's `worker.on('error', ...)`, which is where the old version leaned for
 * "the projection file could not be opened" and similar. A forked child process has no equivalent:
 * `ChildProcess`'s own `'error'` event fires only for a spawn, kill or send failure, never for an
 * uncaught exception in the child's own code - an uncaught throw here would instead just crash the
 * process with a bare, unstructured exit code, and the parent would have nothing but "the query
 * was stopped before it finished" to say about it. Catching everything here and always replying
 * over the IPC channel is what keeps that failure mode as informative as every other refusal.
 */
import BetterSqlite3 from 'better-sqlite3'
import { MAX_TEXT, MAX_RESULT_BYTES } from './contract.ts'

interface SqlChildInput { projectionPath: string, sql: string, rowCap: number }

type ChildReply =
  | { kind: 'ok', columns: string[], rows: unknown[][], truncated: boolean, textTruncated: boolean }
  | { kind: 'error', name: string, message: string, code: string | null }

function send(reply: ChildReply): void {
  // Present on every process started with fork() - it always wires up the ipc channel - so this
  // is the child_process equivalent of the old parentPort! non-null assertion, for the same
  // reason: only ever undefined in a process that was not started the way this one always is.
  process.send!(reply)
}

// The payload arrives over the fork's own IPC channel rather than as workerData, since
// child_process has no constructor-time data option the way `new Worker(path, { workerData })`
// did. runSql.ts sends it immediately after fork() returns, before this listener could plausibly
// have missed it - confirmed by direct measurement rather than assumed: a send() issued before the
// child's own listener attaches is queued, not dropped (three runs, zero drops), so a one-shot
// handler here is enough.
process.once('message', (input: SqlChildInput) => {
  const { projectionPath, sql, rowCap } = input
  let db: BetterSqlite3.Database | undefined
  try {
    db = new BetterSqlite3(projectionPath, { readonly: true, fileMustExist: true })
    const statement = db.prepare(sql)
    // raw() gives arrays rather than objects: it halves a 500-row payload and keeps the column
    // names in one list the summary walk counts rather than descending into per-row keys.
    const columns = statement.columns().map((c) => c.name)
    const rows: unknown[][] = []
    let truncated = false
    let textTruncated = false
    // The running total MAX_RESULT_BYTES bounds. See contract.ts for why 2MB and why this is a
    // different dimension from MAX_TEXT (one cell) and rowCap (row count) - neither of those
    // bounds their product, which is what let 600 columns x 500 rows reach 1.8GB RSS.
    let totalBytes = 0
    for (const row of statement.raw().iterate() as IterableIterator<unknown[]>) {
      if (rows.length >= rowCap) { truncated = true; break }
      const mapped = row.map((cell) => {
        // Checked before the string branch, and checked at all only because of a measurement: a
        // BLOB comes back from better-sqlite3 as a Buffer, which is a Uint8Array and not a
        // string, so it would otherwise pass through every bound below untouched. A Buffer is
        // meaningless to an agent reading JSON anyway, and no projection column holds a binary
        // value, so nothing legitimate is lost by replacing it with a placeholder here.
        if (cell instanceof Uint8Array) { textTruncated = true; return `<${cell.length} bytes>` }
        if (typeof cell === 'string' && cell.length > MAX_TEXT) {
          textTruncated = true
          return cell.slice(0, MAX_TEXT)
        }
        return cell
      })
      const rowBytes = mapped.reduce((sum: number, cell) => sum + cellBytes(cell), 0)
      // Checked before the row is kept, not after: a row is built once either way, but only a row
      // that fits the remaining budget is added to what crosses the IPC channel and later gets
      // JSON.stringify-ed in adapter.ts.
      if (totalBytes + rowBytes > MAX_RESULT_BYTES) { truncated = true; break }
      totalBytes += rowBytes
      rows.push(mapped)
    }
    send({ kind: 'ok', columns, rows, truncated, textTruncated })
  } catch (error) {
    // Flattened to plain data rather than sent as-is - still necessary, but for a different
    // mechanism than the worker_threads version this replaces documented. That version worried
    // about structuredClone, which postMessage uses and which only special-cases the built-in
    // Error subclasses; better-sqlite3's SqliteError was not among them, so a cloned one arrived
    // with name and message undefined and only its enumerable `code` surviving. A forked child's
    // IPC channel serialises with plain JSON.stringify instead (child_process's default
    // `serialization: 'json'`), which is a different mechanism but lands on the same symptom for
    // the same underlying reason - name, message and stack are non-enumerable own properties of
    // an Error, so JSON.stringify drops all three, while a plain enumerable property like `code`
    // survives. Measured directly: a thrown Error with an enumerable `code` arrives at the parent,
    // sent unflattened, as `{"code":"..."}` - name and message both gone. The fix is the same one
    // rebuildInWorker.ts and the old sqlWorker.ts both reached for: pull the fields out by hand
    // before they cross the boundary.
    const err = error as Error & { code?: string }
    send({ kind: 'error', name: err.name, message: err.message, code: err.code ?? null })
  } finally {
    db?.close()
  }
})

/** A rough byte size for one cell, for the running total against MAX_RESULT_BYTES. */
function cellBytes(cell: unknown): number {
  if (typeof cell === 'string') return Buffer.byteLength(cell)
  if (cell === null || cell === undefined) return 4
  if (typeof cell === 'number' || typeof cell === 'boolean') return 8
  // Nothing legitimate reaches here - every cell is a string, a number, a boolean, null, or a
  // Buffer already replaced with a placeholder string above - but a conservative default costs
  // nothing if some future SQLite type slips through untouched.
  return 16
}
