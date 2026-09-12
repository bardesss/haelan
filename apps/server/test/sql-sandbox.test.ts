import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema, ConfigError, DATABASE_FILENAME } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { CATALOGUE } from '../src/mcp/catalogue.ts'
import { SQL_ROW_CAP } from '../src/mcp/runSql.ts'
import { seedToolData } from './mcp-fixtures.ts'

const tool = () => CATALOGUE.find((t) => t.name === 'sql_query')!

let test: TestDatabase
let alice: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  seedPerson(test.db, 'bart')
  seedToolData(test.db)
  alice = new PersonQuery(test.db, 'alice')
})
afterEach(() => test.cleanup())

const run = (sql: string) => tool().run(alice, { sql }) as Promise<{
  columns: string[], rows: unknown[][], truncated: boolean, textTruncated: boolean
}>

describe('what the caller\'s SQL cannot reach', () => {
  // The header comment this replaced claimed all seven cases below rest on one thing: the
  // caller's string reaching prepare().iterate() and nothing else. Measured, that is true of
  // exactly one of them (VACUUM INTO). The rest are refused by a *different* leg - readonly, the
  // driver's own prepare()-time multi-statement check, or a runtime error thrown from inside
  // iterate() itself - and would still be refused if the sandbox called .run() instead. Each case
  // below now says which leg it actually pins, checked by hand against both APIs before writing
  // the comment (see the worked table in the M4 fix-wave report for the raw output).
  //
  // The live-database path matters for the ATTACH case specifically: a readonly connection
  // refuses ATTACH of a path that does not exist through *any* API, for a reason that has nothing
  // to do with this sandbox's own defences. 'haelan.db' - the path this file used before - is not
  // this app's live database filename (that's DATABASE_FILENAME, 'haelan.sqlite') and does not
  // exist anywhere test.dir points, so the old test was pinning "SQLite refuses to open a missing
  // file", which every API refuses identically, not "this sandbox refuses to reach the live
  // database". Using the *real*, existing live path is what makes the refusal about the API
  // choice rather than a typo in the test.
  it('cannot ATTACH the live database - refused by the returns-no-data leg, not by the path being missing', async () => {
    const livePath = join(test.dir, DATABASE_FILENAME)
    // Confirmed directly: ATTACHing this same, real, existing file via .run() instead of
    // .iterate() succeeds and a following SELECT against it answers - so this case would go from
    // red to green if the sandbox ever switched from .prepare().iterate() to .prepare().run().
    await expect(run(`ATTACH DATABASE '${livePath}' AS live`)).rejects.toThrow(ConfigError)
  })

  it('cannot smuggle a second statement - refused at prepare() itself, by any API', async () => {
    // better-sqlite3's prepare() throws "The supplied SQL string contains more than one
    // statement" before .run()/.iterate() is ever reached - confirmed directly. This pins that
    // the sandbox routes the caller's string through prepare() at all, i.e. that it never reaches
    // exec(), which is the one better-sqlite3 API that does accept multiple statements. It does
    // not, on its own, say anything about .run() versus .iterate().
    await expect(run("SELECT 1; SELECT 2"))
      .rejects.toThrow(ConfigError)
  })

  it('cannot load an extension, and is told SQLite\'s own reason rather than the canned sentence', async () => {
    // load_extension refuses at iterate() - prepare() and columns() both succeed, since SQLite
    // reports this as a one-column statement before it ever runs. That matters here: this *was*
    // exactly one SELECT, so the canned "sql_query runs exactly one SELECT" sentence would be
    // actively false if it fired here. Asserting only the error class would miss a regression
    // that broadened asAgentError's regex to also swallow "not authorized" - this pins both sides.
    // (This one is refused by a runtime error from inside iterate(), not by the "returns no data"
    // leg the header used to claim for every case - .run() would throw the identical error here
    // too, since the failure is "not authorized", not "no data to return".)
    const error = await run("SELECT load_extension('/tmp/x.so')").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toMatch(/not authorized/)
    expect((error as Error).message).not.toMatch(/exactly one SELECT/)
  })

  it('cannot read a file', async () => {
    // readfile() is the SQLite "fileio" loadable extension, which better-sqlite3 never compiles
    // in - so this proves only that this build has no such function, not that this app's own
    // load_extension refusal above would also stop a build that did have fileio loaded. It earns
    // its place anyway: it pins that whatever message SQLite gives for "no such function" reaches
    // the agent verbatim, not the canned "exactly one SELECT" sentence - the same property the
    // load_extension case above pins, from a genuinely different failure mode. Also refused
    // identically by .run(), for the same reason as load_extension above.
    const error = await run("SELECT readfile('/etc/hostname')").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toMatch(/no such function/)
    expect((error as Error).message).not.toMatch(/exactly one SELECT/)
  })

  it('cannot write - refused by readonly, by any API', async () => {
    // Confirmed directly: "attempt to write a readonly database" is thrown by .run() exactly like
    // .iterate() here. This pins the `readonly: true` connection flag, not the iterate() choice -
    // see the RETURNING case below for the one write shape readonly alone does not cover.
    await expect(run("INSERT INTO daily VALUES ('2026-01-01','steps','sum','merged',1,1,null,0)"))
      .rejects.toThrow(ConfigError)
    await expect(run('DELETE FROM daily')).rejects.toThrow(ConfigError)
  })

  it('cannot write even when the statement returns rows - readonly is the only thing refusing this one', async () => {
    // RETURNING gives the statement data, so iterate() would run this exactly like a SELECT; the
    // `readonly: true` on the connection in sqlWorker.ts is what actually stops it. Drop that flag
    // - it looks redundant beside fileMustExist - and this is the case that would go from red to
    // green while every other write above stayed exactly as it is (readonly is what those pin
    // too, but a plain INSERT/DELETE is refused before RETURNING would even matter).
    await expect(run("INSERT INTO daily VALUES ('2026-01-01','steps','sum','merged',1,1,null,0) RETURNING *"))
      .rejects.toThrow(ConfigError)
  })

  it('cannot VACUUM INTO a file - the one case the returns-no-data leg alone refuses, not readonly', async () => {
    // The actual pairing this file's header used to claim for all seven cases: VACUUM INTO
    // returns no data, so it is refused by columns()/iterate() exactly like ATTACH is - readonly
    // plays no part, because this is a filesystem-write primitive rather than a write to the
    // database it is called against. Confirmed directly, and this is the one case in the file
    // where the difference is real: via .run() on this same readonly connection, VACUUM INTO
    // *succeeds* and creates the file. Every other case above would stay green under .run(); this
    // one would not, which is what makes it the case that actually pins .iterate() over .run().
    await expect(run("VACUUM INTO 'should-never-be-created.db'")).rejects.toThrow(ConfigError)
  })

  it('says what it does allow, rather than naming an API the agent cannot reach', async () => {
    // better-sqlite3's own message here is "This statement does not return data. Use run()
    // instead", which sends an agent looking for a method it has no access to.
    await expect(run('DELETE FROM daily')).rejects.toThrow(/exactly one SELECT/)
  })

  it('reaches no table that holds a credential', async () => {
    for (const forbidden of ['accounts', 'credentials', 'mcp_tokens', 'auth_sessions']) {
      await expect(run(`SELECT * FROM ${forbidden}`)).rejects.toThrow(/no such table/)
    }
  })
})

describe('the total size budget', () => {
  it('stops well short of materialising a wide result, and the sandbox is still usable after', async () => {
    // 60 columns of hex(randomblob(1000)) is ~2000 hex chars each - inside MAX_TEXT, so nothing
    // here trips the per-cell cap - and ~120KB a row. MAX_RESULT_BYTES (2MB) is reached around row
    // 17, well inside both the 100 rows this query could produce and SQL_ROW_CAP's 500: this is
    // the total-byte budget stopping the row loop, not either of the per-dimension caps that
    // already existed. This is a much smaller version of the shape Important 1 measured reaching
    // 1.8GB RSS (600 columns x 500 rows) - small enough to run in well under the 5-second deadline
    // on a slow machine, while still exercising the same code path.
    const cols = Array.from({ length: 60 }, (_, i) => `hex(randomblob(1000)) AS c${i}`).join(', ')
    const result = await run(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100) SELECT ${cols} FROM c`,
    )
    expect(result.truncated).toBe(true)
    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.rows.length).toBeLessThan(100)

    // The point of a budget that stops the loop rather than crashing the process: a crashed or
    // OOM-killed child would leave `busy` true forever (nothing would ever fire 'exit' to release
    // it) and every later sql_query on this instance would be refused. This proves the sandbox
    // came back clean.
    const again = await run('SELECT 1 AS one')
    expect(again.rows).toEqual([[1]])
  })
})

describe('the row cap', () => {
  it('stops pulling rather than materialising, so an infinite query still returns', async () => {
    // The shape that burned 10.8 seconds under .all(). Bounded here because the cap is applied by
    // not pulling: measured at 0.8ms for 501 rows of an unbounded generator.
    const started = Date.now()
    const result = await run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c')
    expect(result.rows).toHaveLength(SQL_ROW_CAP)
    expect(result.truncated).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('does not claim truncation when everything fitted', async () => {
    const result = await run('SELECT metric FROM daily LIMIT 3')
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(false)
  })
})

describe('one at a time', () => {
  it('refuses a second concurrent query rather than starting a second child process', async () => {
    const slow = run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c')
    const second = run('SELECT 1 AS one')
    await expect(second).rejects.toThrow(/already running/)
    await slow
  })

  it('is available again once the first finished', async () => {
    await run('SELECT 1 AS one')
    const result = await run('SELECT 2 AS two')
    expect(result.rows).toEqual([[2]])
  })
})

describe('free text', () => {
  it('truncates a very long cell and says so', async () => {
    const long = 'x'.repeat(5000)
    test.db.insert(schema.notes).values({ id: 'long', personId: 'alice', localDate: '2026-08-02', body: long, updatedAtMs: 0 }).run()
    const result = await run("SELECT body FROM notes WHERE id = 'long'")
    expect((result.rows[0]![0] as string).length).toBe(2000)
    expect(result.textTruncated).toBe(true)
  })

  it('replaces a BLOB cell with a placeholder rather than letting a Buffer through', async () => {
    // better-sqlite3 returns a BLOB as a Buffer, which is a Uint8Array and passes the string check
    // above untouched - measured at 500 rows of randomblob(1000000), 500,000,000 bytes, in
    // 1209ms: inside the row cap, inside the deadline, and large enough that sending it to the
    // parent over the sandbox's IPC channel and then JSON.stringify-ing it in adapter.ts throws or
    // OOM-kills the container. A thousand-byte blob is enough to prove the placeholder fires
    // without paying that cost here.
    const result = await run('SELECT randomblob(1000)')
    expect(result.rows).toEqual([['<1000 bytes>']])
    expect(result.textTruncated).toBe(true)
  })
})

describe('the deadline', () => {
  it('gives up on a CPU-bound query and leaves the main thread serving', async () => {
    // count(*) over a generated set is the residual neither the row cap nor the byte budget
    // bounds: one row, arriving only at the end, so nothing about its output size gives an early
    // way out. What running this in its own child process buys is that the main thread stays
    // responsive while it burns - which is the whole reason for a separate process, and the only
    // way to prove it is to do something else while waiting.
    //
    // The bound (60,000,000) only needs to outlast the 5-second deadline - sized off direct
    // throughput measurements on this machine (4.1-5.8 million rows/second for this shape
    // unsandboxed) to land the query's own natural runtime around 13-15 seconds, comfortably past
    // the deadline with margin for a slower run. Under the worker_threads version this file used
    // to run, that margin mattered for a second reason: terminate() could not interrupt the
    // native call, so whatever this reached kept burning on its own thread for however much of
    // its natural runtime was left, and the bound was sized to keep that residual burn to seconds
    // rather than the six-to-seven minutes a much larger bound (2 billion) measured. Under
    // child_process that reason is gone - measured directly (see sql-sandbox-deadline-cleanup.
    // test.ts and the M4 fix-wave report), `child.kill()` against this exact shape of query ends
    // the native call in single-digit milliseconds, not minutes. The bound stays the same size
    // anyway, because it still has to outlast 5 seconds to exercise the deadline at all; it no
    // longer has to be kept small for the sandbox's own sake.
    const query = run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 60000000) SELECT count(*) FROM c')
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 100)
    await expect(query).rejects.toThrow(/did not finish within/)
    clearInterval(timer)
    // A blocked event loop fires no timers at all. This is the assertion the child process is for.
    expect(ticks).toBeGreaterThan(10)
  }, 20_000)
})
